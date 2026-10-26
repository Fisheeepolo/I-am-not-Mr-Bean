# v4：源层抽象与内容加权取样

本文件记录实际实现。它是可复现实验方案，不是“所有细线都能保留”的证明，不是语义显著性检测，也不是相机散焦的物理估计。网站将源图限制在至多 640 × 640 后处理；独立函数允许至多 1,638,400 源像素。

## 接口与消融

```js
analyzeImageStructure(imageData, width, height, options = {})
// → {width,height,saliency,gradient,defocus,defocusConfidence,
//    orientation,anisotropy,diagnostics}

abstractImageForPattern(imageData, width, height, {
  targetWidth, targetHeight,
  optimizationMode: 'detail' | 'balanced' | 'easy',
  abstraction: false,       // 可选：仅关闭抽象，仍返回原图分析
  defocusAware: false,      // 可选：仅关闭散焦代理对抽象半径/强度的控制
  analysis                 // 可选：复用源图分析，尺寸和各图长度必须匹配
})
// → {data,width,height,analysis,diagnostics}

sampleImageForPattern(imageData, sourceWidth, sourceHeight, width, height, {
  optimizationMode: 'detail' | 'balanced' | 'easy',
  analysis,
  saliencySampling: false,  // 可选：关闭指数权重，回到alpha面积积分
  contrastRecovery: false  // 可选：仅关闭v3局部对比恢复；不与上一项暗中绑定
})
// → {data,width,height,saliency,defocus,defocusConfidence}
```

分析图均为源尺寸 `Float32Array`，除方向 `orientation` 使用弧度外均在 `[0,1]`。取样返回的三个分析图为目标尺寸。`defocus` 已乘置信度，后续使用它时不必再乘一次。原图与目标尺寸相同时，抽象和取样都原样复制 RGBA；仍可返回分析图。未传目标尺寸的抽象调用默认视为原尺寸。

## 多尺度结构信息

用可分离核 `[1,2,1]/4` 重复卷积。RGB 先预乘 alpha，再分别模糊颜色质量与 alpha 质量并相除；透明像素的隐藏 RGB 不参与分析。记 `B_k` 为 `k` 次卷积后的可见颜色，原颜色为 `c`，均按 `[0,1]` 归一化：

\[
H=\|c-B_1\|_2/\sqrt3,\quad M=\|c-B_6\|_2/\sqrt3,
\]
\[
S_0=0.65M+0.35\|B_3-B_6\|_2/\sqrt3.
\]

在 `B_1` 上用中心差分计算 RGB 梯度，`G_0=sqrt((||dx||²+||dy||²)/3)`。颜色中心差分能响应等亮度但色相不同的边界。归一化分母分别为 `max(.08,P95(S0),.9 max(S0))` 和 `max(.06,P95(G0),.9 max(G0))`，随后截到 `[0,1]`。使用固定 512 档直方图估计 P95；同时参考峰值，避免极小眼睛及其周围被低 P95 一起截成 1。绝对下限避免把很弱的噪声自动放大到满显著性。

结构张量取 RGB 外积之和后再卷积两次：

\[
J=B_2\!\left(\begin{bmatrix}\langle d_x,d_x\rangle&\langle d_x,d_y\rangle\\\langle d_x,d_y\rangle&\langle d_y,d_y\rangle\end{bmatrix}/3\right),\quad
A=\frac{\lambda_1-\lambda_2}{\lambda_1+\lambda_2+\epsilon}.
\]

方向为最小变化方向，即梯度法向旋转 90°；实现用 `0.5 atan2(2Jxy,Jxx-Jyy)+π/2`。结构张量与各向异性椭圆取向依据 [Kyprianidis、Kang、Döllner 2009](https://www.kyprianidis.com/p/pg2009/index.html) 的原则。本实现的稀疏四扇区并非论文的完整八扇区积分或 GPU 实现。

## 有置信度的低高频比代理

对 H、M 再模糊两次得到 `h,m`，定义：

\[
C=\mathrm{clip}_{[0,1]}((m-.008)/.05),\quad
D=C\,\mathrm{clip}_{[0,1]}\!\left(1-\frac{h}{.65m+10^{-6}}\right).
\]

这里 D 仅表示“具有足够中频证据且相对缺少高频”的局部结构，可能来自散焦，也可能来自渐变、原始低频纹理或数字处理。平坦区域 `C=0,D=0`，不能把“没有细节”当成“已识别散焦”。[Zhuo、Sim 2011](https://www.sciencedirect.com/science/article/pii/S003132031100094X) 使用原图与再模糊图的梯度比估计边缘处散焦；当前实现借鉴频率比较思路，未实现该论文的光学模型与全图传播，故不输出散焦半径或光学判定。

## 轻量各向异性 Kuwahara

模式基础参数 `(r,a)` 为：细节 `(1.5,.20)`，均衡 `(2,.45)`，好拼 `(2.5,.65)`。

局部椭圆半轴为：

\[
r_D=r(1+.35D),\quad r_\parallel=r_D(1+.8A),\quad r_\perp=r_D/(1+.8A).
\]

沿切向旋转椭圆，使用中心、四个单位轴向点、四个单位对角点和四个半径 0.5 的轴向点，共 13 个固定采样点；坐标四舍五入为源像素。分成四个重叠象限，轴点同时属于相邻象限，中心属于全部象限。径向权重分别为中心 1、外圈 .5、内圈 .8，并乘源 alpha。每个扇区计算 RGB 均值和平均通道方差 `v_j`，其融合权重为 `q_j=1/(1+(v_j/64)^2)`，其中方差使用 `[0,255]` RGB 单位。

最终与原色混合的比例为：

\[
\eta=[a+(1-a)\,.3D](1-.65S)(1-.5G).
\]

这样 D 连续增大半径和混合强度，S/G 连续保护显著结构。`defocusAware:false` 在上述半径及强度公式中令 D=0。alpha 逐字节复制，不经滤波。有限采样、四扇区和整数位置是速度近似，可能产生取向量化误差；不能称为完整 AKF 复现。

## 指数权重投影与 alpha 分离

对目标格 j 与源像素 i 的几何交叠面积 `a_ij`，设源 alpha 为 `α_i`：

\[
W_i=\exp(\beta_S S_i+\beta_G G_i),\quad
\hat c_j=\frac{\sum_i a_{ij}\alpha_iW_i c_i}{\sum_i a_{ij}\alpha_iW_i},
\]
\[
\hat\alpha_j=\frac{\sum_i a_{ij}\alpha_i}{\sum_i a_{ij}}.
\]

上式给出舍入前的覆盖率；返回值写入 `Uint8ClampedArray`，故最终占位判定是 `Q8(255·α̂_j) ≥ 100`，其中 Q8 为该类型的 8 位钳制舍入。不能将它严格替换成未舍入的 `α̂_j ≥ 100/255`。颜色的重要性权重不会改变这条几何 alpha 路径。目标显著性为 alpha 面积加权 RMS，D 和置信度为 alpha 面积均值。使用 RMS 是保留局部小特征信息的折中，不是语义对象概率。

`(βS,βG)`：细节 `(1.35,.6)`，均衡 `(1.1,.45)`，好拼 `(.75,.3)`。指数权重始终为正，因此未恢复对比时的颜色位于源可见颜色凸包内。原 v3 有界局部对比恢复继续可用；v4 的恢复增益统一乘 .65，且每通道仍限于源格范围。该系数与 `saliencySampling` 独立：关闭显著性只使 W=1，不同时改变恢复强度。开发首版曾将 .65 系数与显著性开关联动，混杂了消融；修复前结果作为历史保留，不用作最终无显著性效果结论。

[Kopf、Shamir、Peers 2013](https://johanneskopf.de/publications/downscaling/) 说明针对内容调整降采样核的研究方向；本项目固定格内指数投影没有优化核的位置和形状，不是该论文算法的复现。

## 细线何时能保留：条件而非保证

考虑一格内只有线色 L 和底色 B。设线占该格**alpha 面积质量**比例 f，组内权重分别近似常数 `wL,wB`，`r=wL/wB`。取样后的线色混合系数：

\[
\lambda=\frac{fr}{fr+1-f}.
\]

在两色量化情形，若沿这条混合曲线线色获选的阈值为 `λ≥τ`，需要：

\[
r\ge\frac{\tau(1-f)}{f(1-\tau)},\qquad
f\ge\frac{\tau}{r(1-\tau)+\tau}.
\]

对 RGB 灰度混合且按 CIELAB 距离匹配纯黑/纯白，阈值约为 RGB 119，即 `τ≈.534`。当 `f=.25`，所需权重比约 `3.44`。当 `f=1/64`，均衡默认权重比即便取上界 `exp(1.55)≈4.71`，也只有 `λ≈.0696`，结果仍接近白色。测试保留了这一反例。

实际条件还会受线与背景的 S/G 值、对齐位置、可用色卡、alpha 阈值、源图抽象和后续量化影响。一个亮背景边缘也可能有高梯度；两个不同位置的线可能落在同一格；透明线的面积不足时颜色权重不能补偿 alpha。故只能在定义好的图像与指标上测改善，不能保证任意细线或人物五官都保留。

## 首版验证与冻结

17 项局部测试覆盖：指数混合公式、独立 alpha 面积、透明隐藏色不污染、方向场、平坦区域零散焦置信度、弱纹理误差下降、强边界保留、原尺寸逐字节不变、确定性、四分之一格眼睛、连续细线、以及 1/64 面积反例。测试中的几何面积基线显式关闭 `saliencySampling`，原有特征保留断言仍验证新默认路径。

本机 Node v24，640² 源图→160²，测试图为两色区域叠加固定种子的弱 RGB 噪声，预热后 3 轮端到端（分析+抽象+取样）中位约 646 ms；量化不在该计时内。它不是浏览器或所有机器的时延承诺。最终算法比较由独立评估脚本记录；本模块参数冻结前未读取新保留组。
