# 内容自适应拼豆算法：独立评测材料

本目录把评测与数值实现分开。目标是核对“原图特征保留”和“实体拼装简单”之间的取舍，不用单个漂亮样例证明普适改进。当前是一套小规模、可重跑的研究原型；没有真实用户拼装试验，也没有支持顶刊/顶会贡献的外部证据。

## 材料入口

- [固定协议](PROTOCOL.md)：数据划分、颜色预算、消融、阈值、统计口径。
- [固定数据清单](fixtures.json)与[协议/数据锁](protocol-lock.json)：每张图的来源、许可、输入尺寸、原始bytes SHA256和真实mask/ROI类型。
- [来源说明](SOURCES.md)：公开照片的许可归属和独立评测API依据。
- [采样和抽象模型](SAMPLING.md)与[空间选色模型](OPTIMIZER.md)：实际数值实现及理论限制，由实现代理维护。
- [实测结果](results/RESULTS.md)、[开发对照](results/development-comparison.html)、[新保留对照](results/heldout-comparison.html)、[实际图纸截图](results/contact-sheet.png)、[色差/碎片散点](results/pareto.svg)。未运行的保留文件不会被虚构创建。
- [结果解释和负例](results/DISCUSSION.md)、[主195条CSV](results/main-metrics.csv)、[分层消融边际CSV](results/ablation-summary.csv)、[选色补充30条](results/PALETTE-RESULTS.md)、[原电脑精确复跑方法](REPRODUCE.md)。

## 哪些是真值，哪些只是代理

程序绘制的合成图有独立几何mask；小眼睛、高光等指定格有已知颜色与邻近背景参照。真实照片没有语义分割真值：部分图只提供预先指定的矩形ROI，哈勃和草地的区域指标不可用。ROI不能称为“识别出的主体”。

照片和合成图的Canny边缘均由统一参数产生，是自动参考。两幅图都无边时F1约定为1，因此删除本就低于Canny阈值的小细节可能反而提高此指标。必须结合真值小特征和逐格图看结果。显著性加权色差使用固定原图的DoG结构代理，不使用待测输出或算法自身的权重；它依然不是人类眼动/语义显著性。

色差由源图RGB和既有色卡HEX在D65参考白下转Lab计算，属于图像域指标。没有实测每批拼豆的反射谱或校准照片，因此不把ΔE00当成实物颜色仪器测量。

原始碎片率不豁免任何眼睛、高光或真实小纹理；≤2格四连通组件全部计数。辅助豁免率只作解释，不能用来宣称原始目标<0.5%已达成。连续形状可能更好拼，也可能已经抹去特征；组件紧凑度与行内换色也不能代替人类拼装时间。

raw JSON中的优化器内部protected/unprotected诊断是实现自身的分组统计，定义/分母与独立评测不同；报告主表只用metrics.py的统一定义，不混用这些百分比。主表显著性豁免来自固定原图参考及明确合成marker，不是对结果事后挑选。

## 可追溯的开发过程

1. v4.1协议先固定输入与评测；运行前审阅补充noDefocus和源图显著性加权色差，成为v4.2。尚未看任何v4输出。
2. v4.2跑7张开发图的84条输出，归档于`development-initial/`；对应数值源码在`development-initial/algorithm/`，每个文件的规范化hash与初次输出一致。
3. 发现开发标注bug：眼睛的一个背景参照点恰好落在斜线上；修正到眼睛上方，逐marker验证原图背景RGB。输入图像、mask、拆分、阈值都没变。v4.3标注和协议在首次保留运行前固定；同一批输出重算指标存`development-v4.1-corrected/`。旧协议、锁和标注留在`protocol-history/`。
4. 开发组显示低反差小特征会被空间项吞并，而关闭空间项能保留；任何进一步数值调整只允许用开发组。最终数值版本、冻结hash和首次保留运行时间见结果JSON，不能把开发结果称作独立验证。
   审查另发现初版noSaliency在关闭指数权重时同时把局部对比恢复增益从0.65改成1，所以该初版消融有混杂。它的数字完整归档，但不能据此单独判断显著性权重贡献。后续修复统一恢复增益，full输出保持不变；新增对照测试检查关闭权重等价于βS=βG=0。
5. 16张白色安全案例全部属于已见回归；本轮只比较完整冻结v3与新v4，不再调用会引用新公共模块的历史v2文件。上一轮白色报告没有覆写。
6. 最终主实现content-aware-v4.2完成195条主评测和64条白色回归，三次运行的数值源码hash完全一致，最终数值依赖存results/algorithm/。新保留组只在最终冻结后首跑，没有根据结果调参。首次保留之前另声明设施选色/加权频数Top-K补充，30条独立运行；15张full正对照与主full/K18逐格一致。完整结论与未达成目标见results/DISCUSSION.md。

## 复跑

建议使用Python虚拟环境，安装`requirements.txt`。Node无需额外包。从项目根目录执行：

```text
python research/content-aware-v4/test_metrics.py
node research/content-aware-v4/lock-protocol.mjs
node research/content-aware-v4/run-benchmark.mjs --split=development
python research/content-aware-v4/evaluate-results.py development
node research/content-aware-v4/run-benchmark.mjs --split=heldout
python research/content-aware-v4/evaluate-results.py heldout
node research/content-aware-v4/run-benchmark.mjs --split=white-regression
python research/content-aware-v4/evaluate-results.py white-regression
python research/content-aware-v4/report-results.py
```

`prepare-fixtures.py`只用于由固定官方源和程序重建数据；正常复跑直接读已保存RGBA，不需要联网、不需要浏览器解码。锁验证会拒绝悄然变化的数据、指标、协议或v3基线。代码散列按UTF8的CRLF/CR→LF，二进制数据按实际bytes。主实验时每条预热1次、测3次中位；完整时长数组和模块SHA256在raw JSON中。算法计时不包含下载、图片解码、指标计算、画布绘制和人工框选。

浏览器主体候选/手动框选与真实用户操作另由主任务验收；本实验不把手动选框收益冒充非AI语义识别。
