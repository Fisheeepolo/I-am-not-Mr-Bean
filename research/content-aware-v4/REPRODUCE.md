# 实际环境与复现

本次运行：Windows、AMD Ryzen AI 7 H 350 w/ Radeon 860M（8核/16逻辑处理器），Node v24.19.0；Python 3.12.14，NumPy 2.5.4、SciPy 1.18.1、scikit-image 0.25.2、Pillow 13.0.0。实际版本也逐次保存在结果JSON；耗时是本机算法时间，不是用户等待总时长或拼装时间。

本机系统Python没有scikit-image，因此实验使用独立依赖目录。实际路径：

- Node：`C:/Users/33544/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`
- Python：`C:/Users/33544/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`
- 额外Python依赖：`C:/Users/33544/Documents/Codex/2026-10-25/new-chat/work/research-python`
- 项目：`C:/Users/33544/Documents/Codex/2026-10-25/new-chat/work/bead-studio`

## 在原电脑执行

在PowerShell中先进入项目目录。**重跑会写入results/；先复制现有results/到新的归档目录，避免覆写已发布证据。** development-initial/、development-v4.1-corrected/和protocol-history/是历史记录，不要删除或重用其名字。

```powershell
Set-Location 'C:/Users/33544/Documents/Codex/2026-10-25/new-chat/work/bead-studio'
$env:PYTHONPATH = 'C:/Users/33544/Documents/Codex/2026-10-25/new-chat/work/research-python'
$researchPython = 'C:/Users/33544/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
$researchNode = 'C:/Users/33544/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'

& $researchPython research/content-aware-v4/test_metrics.py
& $researchNode research/content-aware-v4/lock-protocol.mjs

& $researchNode research/content-aware-v4/run-benchmark.mjs --split=development
& $researchPython research/content-aware-v4/evaluate-results.py development
& $researchNode research/content-aware-v4/run-benchmark.mjs --split=heldout
& $researchPython research/content-aware-v4/evaluate-results.py heldout
& $researchNode research/content-aware-v4/run-benchmark.mjs --split=white-regression
& $researchPython research/content-aware-v4/evaluate-results.py white-regression
& $researchPython research/content-aware-v4/report-results.py

# 独立补充选色研究（与主计时串行）
& $researchNode research/content-aware-v4/palette-study.mjs --split=development
& $researchNode research/content-aware-v4/palette-study.mjs --split=heldout
& $researchPython research/content-aware-v4/evaluate-results.py palette-study-development
& $researchPython research/content-aware-v4/evaluate-results.py palette-study-heldout
& $researchPython research/content-aware-v4/report-palette.py
```

这些命令直接读取仓库中已经保存的RGBA和mask，不需要下载图像、连接AI、浏览器Canvas或读取私人文件。已有protocol-lock.json时，锁命令只核对，内容不符会报错。不要删锁来绕过检查。

## 在其他电脑执行

安装Node 24和Python 3.12，创建Python虚拟环境，再执行：

```text
python -m pip install -r research/content-aware-v4/requirements.txt
python research/content-aware-v4/test_metrics.py
node research/content-aware-v4/lock-protocol.mjs
```

之后使用README中的标准node/python跑法。图像结果应确定性相同；跨平台浮点、库版本、CPU和其他负载可影响最后小数及计时。不要把此机器的毫秒数外推到手机。

## 结果与版本

- 每图主预算K18比较9种方法，K12/24各比较v3/full，共195条主记录。16例白色安全回归×2种去底状态×2算法，共64条记录。
- 每条预热1次、再测3次，记录原始3次时长与中位；指标计算不在计时内。运行期间数值模块发生变化会失败，不能混合版本。
- raw JSON包含实际色号网格、能量诊断和源码hash；评测JSON/CSV来自独立Python算法；HTML/PNG是这些实际网格的可视化。
- baseline/是原v3完整独立依赖。首版开发v4.1源码在development-initial/algorithm/，无需依赖后来公共模块。初版混合消融和标注修正记录见README。
- 文本SHA256先把CRLF/CR规范到LF，图像/字节数据直接hash。协议、数据与指标锁在算法首个保留组运行前固定。
