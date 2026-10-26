# 加权频数与设施选色的补充对照

预先声明、权重与正交性边界见 [SUPPLEMENTAL-PROTOCOL.md](SUPPLEMENTAL-PROTOCOL.md)。产品数值仍为冻结的 `content-aware-v4.2`；本目录新增研究脚本，不改主评测、指标或锁。

## 复现

在主实验计时完成后执行：

```text
node research/content-aware-v4/palette-study.mjs --split=development
node research/content-aware-v4/palette-study.mjs --split=heldout
```

输出为 `results/palette-study-development-raw.json` 与 `results/palette-study-heldout-raw.json`。它们保留逐格实际色号、候选频数、处理后输入 hash、原始图片和算法 hash。由独立评测代理调用原有 `metrics.py` 给出评分，研究脚本不自行输出质量指标。

端到端计时覆盖已解码 RGBA 到图纸网格。共同阶段包括分割、抽象、采样、风格和与产品完全一致的 alpha/Lab 转换；frequencyPalette 的额外 Top K 选择和两臂各自优化器时间单独列出。固定候选仍经过生产优化器内部的候选代价构建，实际开销保留，不人为扣减。

## 解释限制

两臂使用同一原始数据和同一套后续 D/V/H 优化程序，但候选集合会影响初始标签、图割遍历标签和微结构保护预算。因此该对照识别的是完整系统内的选色策略替换效果，并不孤立 medoid 或把微保护数值图强制固定。既定数据较少，统计结果不代表所有照片或手工拼装体验。

结果尚未生成；完成后由独立评测在相应 JSON 中记录，不能以预期收益替代实测。
