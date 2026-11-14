#!/usr/bin/env python3
"""PDF → 逐页「按 y 聚类的行」JSON（只读文本层，不做 OCR）。

为什么需要它：PDF 文本层的 raw 顺序是**绘制顺序**，不是阅读顺序（实测康圣达/海思特版式：
抬头 8 个「标签」先行、5 个「值」后置，逐行正则配不上对）。按词的 y 坐标聚类成行、行内按 x 排序后，
「标签：值」自然回到同一行，正则才可写。

用法：
  python3 tools/pdf-extract.py <file.pdf>                      # stdout: JSON
  python3 tools/pdf-extract.py <file.pdf> --render <outdir>    # 另存每页 page-N.png（200dpi）

输出：{ ok, pageCount, hasTextLayer, pages: [{ page, width, height, lines[], wordCount }] }
依赖：PyMuPDF（import fitz）。缺失时返回 { ok:false, error }，不抛栈。
"""
import json
import os
import sys


# MuPDF 的语法错误（`cannot find ExtGState resource`）写在 **fd 1**（C 层），
# 只重定向 sys.stdout 拦不住，会把 JSON 污染成不可解析。故在调用 fitz 期间把 fd 1 指向 devnull。
class _SilenceFd1:
    def __enter__(self):
        self._devnull = os.open(os.devnull, os.O_WRONLY)
        self._saved = os.dup(1)
        os.dup2(self._devnull, 1)
        return self

    def __exit__(self, *exc):
        os.dup2(self._saved, 1)
        os.close(self._saved)
        os.close(self._devnull)
        return False


def fail(msg):
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(0)


def main():
    args = [a for a in sys.argv[1:]]
    if not args:
        fail("用法：python3 tools/pdf-extract.py <file.pdf> [--render <outdir>]")
    path = args[0]
    render_dir = None
    if "--render" in args:
        i = args.index("--render")
        if i + 1 >= len(args):
            fail("--render 需要目录参数")
        render_dir = args[i + 1]

    try:
        import fitz  # PyMuPDF
    except Exception:
        fail("缺少 PyMuPDF：pip3 install pymupdf（安装后重跑；或改用图片走 8008 OCR）")

    try:
        with _SilenceFd1():
            doc = fitz.open(path)
            _ = doc.page_count
    except Exception as e:
        fail(f"打不开 PDF：{e}")

    pages = []
    for i, page in enumerate(doc):
        # 词级 bbox：y 相近（<4pt）视为同一行；行内按 x 排序
        with _SilenceFd1():
            words = page.get_text("words")
        rows = []
        for w in sorted(words, key=lambda w: (round(w[1], 1), w[0])):
            y = w[1]
            if rows and abs(y - rows[-1]["y"]) < 4:
                rows[-1]["w"].append({"x": w[0], "t": w[4]})
            else:
                rows.append({"y": y, "w": [{"x": w[0], "t": w[4]}]})
        lines = []
        for r in rows:
            r["w"].sort(key=lambda t: t["x"])
            line = " ".join(t["t"] for t in r["w"]).strip()
            if line:
                lines.append(line)
        pages.append({
            "page": i + 1,
            "width": page.rect.width,
            "height": page.rect.height,
            "lines": lines,
            "wordCount": len(words),
        })

    if render_dir:
        try:
            import os
            os.makedirs(render_dir, exist_ok=True)
        except Exception:
            pass
        try:
            with _SilenceFd1():
                for i, page in enumerate(doc):
                    pix = page.get_pixmap(dpi=200)
                    pix.save(f"{render_dir}/page-{i + 1}.png")
        except Exception:
            pass

    print(json.dumps({
        "ok": True,
        "pageCount": doc.page_count,
        "hasTextLayer": any(p["wordCount"] for p in pages),
        "pages": pages,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
