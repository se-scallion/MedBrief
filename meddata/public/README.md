# meddata/public —— 第三方识别资源（不入库）

本目录下的两个子目录**故意不入库**（.gitignore 已排除），合计约 49 MB：

| 目录 | 体积 | 内容 |
|---|---|---|
| `tesseract/` | 43 MB | tesseract-core WASM / wasm.js（多版本） |
| `traineddata/` | 6.3 MB | `eng.traineddata`、`chi_sim.traineddata` |

## 为什么排除

纯第三方二进制，可从 MedData 仓按原样复制；塞进 git 会让仓库体积翻 20 倍，且无法 diff/review。

## 拿不到时会怎样

`meddata/src/utils/ocr.js` 把路径硬编码成 `/tesseract/...`、`/traineddata/...`（见 `meddata/mount.mjs:277`）。
缺这两个目录 → **只有「MedData 浏览器端 tesseract 引擎」不可用**（`ocrEngines.js` 的 `local` 管线）。
**MedBrief 主链路不受影响**：资料导入走服务端 OCR（8008 / ocr-vision），不依赖这里。

## 怎么补

```bash
# 在 MedData 仓根目录
cp -R meddata/public/tesseract meddata/public/traineddata <MedBrief>/meddata/public/
```

（不写自动下载脚本：来源本来就是 MedData 仓，再引一个外部下载地址属于新增不可控依赖。）
