# 预先固定的评测协议 v4.1

2026-10-26；本文件和 fixtures.json 在运行新版输出前固定。旧照片 astronaut / chelsea / rocket 都已在此前研究中看过，全部属于开发组。coffee / hubble_deep_field / retina / grass 是本轮新保留照片；另有四个新合成保留案例。开发7例、保留8例。保留组在实现参数冻结后才运行，后续不据其调参；若发现必须修复的硬性bug，记录后将其降为回归。

## 输入与公平条件

- 照片只用 scikit-image 0.25.2 官方公开样例；许可/作者/下载URL/原文件与解码RGBA SHA256在fixtures.json逐项记录。官方许可文档为 https://scikit-image.org/docs/stable/api/skimage.data.html 。coffee/grass/retina为CC0；Hubble为NASA公共领域。图片不是私人照片。
- 图纸最长边64格，保持原始长宽比，无裁切；源RGBA统一至目标4倍，Pillow LANCZOS预缩，预缩输出随数据保存；合成图256²→64²。
- 原始风格、balanced、removeBackground:false、完整MARD291色卡。主K18比较 v3、full、noSaliency、noAbstraction、noSpatial、noIslands、lab76；K12和K24各比较v3/full。即每图11条测量，165条主实验。所有方法同时核验色数≤K、色号在色卡内、占位与v3相同。
- v3从baseline/pattern-pipeline.js独立调用，所有依赖已冻结；新算法从网站同一pure pipeline调用。无app/Canvas解码/主观主体框选参与。计时只含算法、预热1次，再测3次取中位，另报每轮原始毫秒。
- 消融：noSaliency只关saliencySampling，保护map保持；noAbstraction关abstraction；noSpatial关spatialRegularization；noIslands关islandPenalty；lab76把colorMetric改lab76。它们是机制诊断，不是所有组合穷举。

## 固定指标（独立Python实现）

1. **自动参考边缘**：RGB按scikit-image rgb2gray转亮度；原始源图与每个图纸最近邻投影都在4倍图纸的同尺寸网格上运行Canny，sigma=1.2源像素、low_threshold=.08、high_threshold=.20、use_quantiles=False。边缘F1分别报告精确位置、欧氏距离≤4源像素（1豆）两个版本；precision/recall独立最近边匹配，不是一对一匹配。均无边=1；仅一方有边则F1=0。这是自动proxy，不是人工真实边界或认知评分，平滑参考可能遗漏弱线，容差版可宽容错位。
2. **原始孤岛/碎片率**：同色4连通组件面积≤2的总格数 / 全部非空格，不排除眼睛和高光，主表逐图判定是否严格<0.5%。同时报碎片数、原始格数。辅助“参考高反差/标注细节豁免”只将组件内任一格的面积平均参考与四邻平均ΔE00≥12、或命中显式合成marker视为显著；这是独立解释性proxy，不是人工语义真值，也不是实现的保护图。豁免前后都报，不能用豁免后的数替换目标。
3. **紧凑度**：每个同色4连通组件沿像素格边数周长P（含图像外界和孔洞），C=P²/(4πA)。报告组件均值、按面积加权均值；单格=4/π>1，数字栅格不是连续欧氏轮廓，此数不解释为越接近1必然更好。
4. **色差**：skimage.color.rgb2lab + deltaE_ciede2000（独立于产品实现），参考为源RGBA按4×4 alpha预乘面积平均，重建色为实际色卡RGB。全图非透明共同占位平均ΔE00；缺失占位单独断言，不能静默不计。合成mask为绘图几何真值（部分是特征区域而非整个主体）；照片只有预先指定矩形ROI代理。分别报regionΔE00、complementΔE00与按region权重2、其他权重1的weightedΔE00。没有mask/ROI时区域指标null，绝不自动伪造主体/背景真值。
5. **真值小细节**：仅合成marker；输出marker与固定邻近背景点须不同色，且沿期望Lab差向量的投影≥期望的0.5，且ΔE00对比≥期望的0.5。另报原始对比保留比、目标色差。可测指定小特征，不等于真实照片人脸识别。
6. **实体操作proxy**：相邻非空横格换色次数、实际颜色数和算法运行时。均不是实际用户工时。

## 白色安全回归

复用white-preservation中全部16例（全部已见，不再称保留），在原始各自尺寸下比较真正冻结v3与v4；去底false/true，tolerance20，K18。64条记录，断言每格null相等，分别报告白色前景误删和背景残留；不得覆写上一轮研究结果。

## 结果约束

只按事先固定的开发/保留、照片/合成分类汇总，给全部逐图原始数、负结果和K12/18/24预算取舍。以散点Pareto（色差、原始碎片、边缘）说明不能同时最优。目标<0.5%逐图实报；不删除保留组失败图、不调整自动阈值。没有人类评价、实体拼装、统计代表性抽样或发表证据，不能据工程数据宣称普适最优/顶刊成果。

代码散列统一UTF8文本CRLF/CR→LF后SHA256；数据散列按原始bytes。协议/数据锁记录写入protocol-lock.json；跑前、跑后都验证。算法冻结散列在每次run JSON中记录。
