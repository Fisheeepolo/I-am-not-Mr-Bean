# 输入图像及评测工具来源

2026-10-26核对[scikit-image官方样例文档](https://scikit-image.org/docs/stable/api/skimage.data.html)。下载使用固定v0.25.2官方仓库，原文件存data/originals/，解码输入、来源URL、许可和SHA256在fixtures.json。没有上传私人图像，也没有生成式AI合成图。

|图像|组别|归属/许可|备注|
|---|---|---|---|
|astronaut|开发|NASA，公共领域|此前实验已使用，不再作新保留|
|chelsea|开发|Stefan van der Walt，CC0|此前实验已使用|
|rocket|开发|SpaceX，公共领域|此前实验已使用|
|coffee|新保留|Rachel Michetti，CC0；Pikolo Espresso Bar|官方文档明确摄影者|
|hubble_deep_field|新保留|NASA，公共领域；HubbleSite|公开天文照片，不作语义主体标注|
|retina|新保留|Mikael Häggström，CC0 1.0；Wikimedia|公开医学样例，不涉及私人患者资料|
|grass|新保留|官方文档标为CC0，原出处[linolafett / Grass 01](https://www.deviantart.com/linolafett/art/Grass-01-434853879)|原作品页本次返回403；许可依据scikit-image官方文档，未声称已读原页|

8张合成图由prepare-fixtures.py独立绘制，固定种子、几何mask和指定小特征；4开发、4新保留。16张白色专项图全部为此前已见回归，绝不重新标作独立保留。

独立指标使用scikit-image 0.25.2、SciPy和NumPy，版本记录于结果JSON。[Canny官方API](https://scikit-image.org/docs/0.25.x/api/skimage.feature.html#skimage.feature.canny)和[CIEDE2000官方API](https://scikit-image.org/docs/0.25.x/api/skimage.color.html#skimage.color.deltaE_ciede2000)用于核对实现定义；评测程序不调用产品的颜色距离或显著性实现。Canny是自动参考，ROI只是矩形区域代理，不能当作人工分割真值。
