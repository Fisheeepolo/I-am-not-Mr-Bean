# v4 受限色卡与拼装优化器

版本：`content-aware-v4.2` 开发修订。v4.1 首版及其实测已另行归档；修订依据仅来自开发组的低反差细节失败，未读取独立保留组。下面微小结构门槛在执行修订定向试验前已声明；等待完整开发评测后由主流程最终冻结，不再按保留组调参。实现为 `public/color-utils.js`、`public/graph-cuts.js`、`public/pattern-optimizer.js`。v3 基线位于本目录 `baseline/`，不修改。

## 接口与约束

`optimizePatternColors(labs, width, height, palette, options)` 保留原入口，返回 `cells/counts/diagnostics`。`labs[i]` 是原目标格的 CIELAB 三元组，`null` 是确定的空位。优化器只给非空位置分配真实可用色卡中的色号，空位集合不变，使用色数不超过 `maxColors`。色卡限制为 1–1000 色。应用界面最大图纸 160×160、最大用色 64。

新增选项：

- `colorMetric`: 默认 `de2000`，可用 `lab76` 做消融。该选项影响选色代价、单格代价和源图相邻色差。
- `saliencyMap`、`defocusMap`: 与目标格同长度的 0–1 值；不提供时显著性由局部对比作保守替代，虚化取 0。
- `spatialRegularization:false`: 关闭 Potts 项与图割阶段。
- `islandPenalty:false`: 关闭小连通域项。它与上一选项独立。
- `microProtection:false`: 关闭 v4.2 的源证据微小结构边界预算，便于独立量化它保留细节及同时保留噪声的代价。
- `optimizationMode`: `detail/balanced/easy`。
- `collectTimings:true`: 可选阶段计时。默认不读取时钟，`diagnostics.timings=null`，整个结果可重复比较。评测也可在外部计时。

## CIEDE2000

`deltaE2000(aLab,bLab)` 实现标准观察条件 `kL=kC=kH=1`，处理零彩度、色相环绕和跨 180° 分支。它在这里是感知色差，不假设满足所有数学距离公理。Potts 的标签差异仍是离散度量，因此图割的可表示性不依赖 ΔE00 是否满足三角不等式。

核对依据为 [Sharma、Wu、Dalal 论文作者页面](https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/)、[论文](https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/ciede2000noteCRNA.pdf) 和作者维护的 [34 对测试数据](https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/dataNprograms/ciede2000testdata.txt)。本仓库保留原始数据到 `tests/fixtures/ciede2000-sharma.txt`，与发布至小数点后 4 位的参考值比较，容差为 0.00005。作者说明这些资料不是 CIE 官方软件实现。

## 受限色卡选择

令候选色卡为 P，源格颜色为 L_i，显著性 s_i、虚化 f_i、局部最大相邻色差 q_i。

```text
r_i = min(1, q_i / 25)
w_i = (1 + 2 s_i + 0.5 r_i) × (1 − 0.55 f_i (1 − s_i))
F(S) = Σ_i w_i min_{c∈S} ΔE(L_i,C_c)²,  S⊆P, |S|≤K
```

完全相同的 Lab 源颜色仅合并权重。若唯一源颜色数乘色卡数不超过 3,000,000，则选色使用全部唯一颜色代价，无颜色聚类近似。6400 格×291 色在这个预算内。超过预算时采用确定性的 Lab 网格分箱，每箱选择最接近箱中心的一个**实际源样本**，合计该箱权重。分箱只用于限制选色计算量，诊断明确报告近似方法、箱宽、代表数和矩阵大小；它不是非欧氏色差的精确充分统计。

先选总代价最小的单一色卡色，再按最大剩余误差下降量贪心增加颜色。随后至多两轮：把每个样本分给当前所选色，在每个分组内遍历仍合法的色卡候选，以全部成员的加权色差平方和重新选择离散中心。不会用 Lab 均值替代 ΔE00 的分组代价。每轮都记录真实的代表样本目标值。该过程是离散设施选址近似，不保证全局最优。

选定色卡后，每个原始唯一源颜色与所选 K 色重新计算代价（未分箱时复用矩阵）。最终单格目标始终使用原始源格，代价矩阵以 Float32 存储、加权和以 Float64 累加；“完整代价”不表示无限精度算术。

## 固定色卡的全图目标

```text
E(z) = D(z) + V(z) + H(z)
D(z) = Σ_i w_i ΔE(L_i,C_{z_i})²
V(z) = Σ_(i,j) a_ij [z_i ≠ z_j]                 # 四邻接，每对只计一次
a_ij = λ exp(−ΔE(L_i,L_j)²/(2σ²))
       × (1 − 0.55 max(s_i,s_j))
       × (1 + 0.8 mean(f_i,f_j)(1 − mean(s_i,s_j)))
H(z) = Σ_同色四连通域C η [|C|≤2] [C非保护]
       × (1 − mean_C(s))² × (1 + 0.5 mean_C(f))
```

保护格满足 `s_i≥0.65`，或 `q_i≥24 且 f_i<0.5`。含任何保护格的小连通域不收取孤岛项，合并阶段也不主动删除它。保护不是不可修改的硬标签；其他图像目标仍可能改变其颜色。高对比噪声也可能被保护，这是无语义信息时的明确局限。

### v4.2 源证据微小结构与边界预算

开发组发现 v4.1 将低反差真实 1–2 格特征全部并入底色。单格特征的统一并入底色增加数据项约 16.97，却减少边界项约 50.91；两格特征分别是 54.31 与 77.54。因此这不是颜色数不足，而是绝对色差较小时，固定 σ 使 Potts 边界惩罚压过其颜色证据。只降低全局 λ 会同时削弱对无关纹理的整理，因此修订仅改变有局部源证据的小组件边界预算。

在初始最近所选色标签上找 1–2 格四连通块 C，其外围取可见的八邻域环 R。进入保护须同时满足：

| 门槛 | 预先声明的数值 |
|---|---:|
| 环中不同可见格数量 | ≥4 |
| 源组件平均 Lab 与环平均 Lab 的色差 gap | ≥1 |
| 组件内部 RMS 色差 | ≤0.35×gap |
| 环内部 RMS 色差 | ≤0.50×gap |
| 组件平均显著性 | ≥0.20 |
| 组件显著性减环显著性 | ≥0.05 |
| 组件平均虚化 | ≤0.30 |

这里 Lab 均值仅是局部一致性描述，不被用作 ΔE00 设施选址的充分统计。上述是本项目保守工程门槛，不是论文给出的标准或语义识别阈值。

对通过门槛的组件，使用完整 K 色数据项计算

```text
m_C = min_{t∈S, t≠z_C} Σ_{i∈C}(D_i(t) − D_i(z_C))
B_C = Σ_{(i,j): i∈C,j∉C} a_ij
若 m_C > 1e−8:
    a_ij ← a_ij × min(1, κ m_C / B_C)  对跨边界边
    κ = 0.5
    将 C 标记为保护，H(C)=0
```

κ=0.5 表示给边界最多一半的可辨别数据增量预算。共享边的后续缩减只会进一步降低已保护组件的边界总和。**所有缩放只在优化开始前执行一次**，随后 a_ij 固定且非负，二元 Potts 图割仍满足次模条件。

可推导的局部下界严格限定为：初始组件统一改成另一个所选色、其余格标签固定，ΔD≥m_C 且最多节省 B_C≤κm_C，所以 Δ(D+V)≥(1−κ)m_C>0。它不覆盖组件内非统一改色、邻域同时变化、完整 H 的变化或全局语义；相邻小组件合并可能减少 H。因此算法仍按完整 E 接受提案，不宣称微小特征永远不变。具有相同低反差一致性证据的孤立噪声也可能获得保护，必须在照片/噪声数据上同时报告这一代价。

| 模式 | λ | σ | η（孤岛阶跃） | 图割完整轮数上限 |
|---|---:|---:|---:|---:|
| 细节 | 0 | 7 | 0 | 0 |
| 均衡 | 18 | 7 | 18 | 2 |
| 好拼 | 42 | 10 | 50 | 2 |

ΔE 无量纲。D 使用其平方的加权和；λ、η 以相同的能量数值尺度计，σ 是相邻色差尺度，均不是分钟或实际劳动成本。没有额外隐藏的 γ 系数；完整权重就是表中 λ/η 与上式显著性、虚化因子。`lab76` 消融保持这些冻结数值不变。

## 真正的 α-expansion 与高阶项边界

固定 alpha 后，每格仅可保留原标签或改成 alpha。Potts 二元表满足次模条件，用 s–t 最小割精确求出该**二元提案**。实现采用显式栈的 Dinic 最大流，不调用递归 DFS。轮流遍历所选标签，至多两轮，接受严格下降提案。[Boykov、Veksler、Zabih，PAMI 2001](https://www.cs.cornell.edu/~rdz/Papers/BVZ-pami01-final.pdf) 是扩展移动与 Potts 图割依据。

H 依赖重新形成的连通域，不是本实现普通图割的二元 Potts 项。这里不宣称图割精确求解 H，也不将有限轮数的结果说成全局最优：先对 D+V 求最优 alpha 提案，再计算提案的 H，仅当完整 E 下降才接受。启用 H 后不能直接套用标准纯 pairwise alpha-expansion 的近似界。

随后进行至多两轮小组件合并提案。对每个非保护且大小≤2的整块，尝试改成其相邻组件的标签。完整能量差包括：该块所有格的数据代价差、全部外边界的 Potts 差、源组件/相邻目标组件合并前后的 H 差。Union/find 维护目标组件，只有完整能量下降才接受，每轮再全图重新计算 E 验证。这个步骤是有限提案搜索，不是高阶精确优化。

```text
validate source/mask/catalogue
compute contrast, saliency/defocus weights and fixed graph edges
choose ≤K catalogue entries by greedy facility + discrete medoid refinement
build original-cell unary costs; initialize nearest labels
if microProtection: detect gated source extrema; cap their fixed edge budget; exempt H
for bounded passes and each alpha:
    proposal ← exact binary min-cut for D+V
    accept only if D(proposal)+V(proposal)+H(proposal) decreases
for two component passes:
    propose whole ≤2 unprotected components merging to adjacent colours
    accept only exact full-energy decrease; verify full scan after pass
return original null mask + catalogue codes + objective diagnostics
```

## 验证与可审计输出

- `tests/color-utils.test.mjs`：34 对作者参考值、对称性、恒等值、sRGB 边界有限性。
- `tests/graph-cuts.test.mjs`：90 个随机次模二元问题、60 个三标签问题的所有 alpha 移动与逐一穷举一致；区域移动摆脱单格 ICM 局部困境；高阶接受检查；20,000 节点长链不爆栈。
- `tests/pattern-optimizer.test.mjs`：既有色卡/用色上限、null、特征保留、确定性和压力回归。
- `tests/pattern-optimizer-v4.test.mjs`：≤2阶跃、显著性保护、正交消融开关、完整能量与离散中心目标不增、输入特征图校验；低反差微小结构保护及消融、固定边界预算下界、虚化排除门槛。

诊断保存初始及每个接受的图割、每轮组件提案的 D/V/H/总能量，选色目标轨迹，受保护/未保护格中属于≤2小组件的比例（分别以各自格子总数为分母），耗时可由外部测量。孤岛率和色差都是代理指标；没有把它们解释为已测得的人类拼装速度、图像语义正确率或视觉最优证明。
