#!/usr/bin/env python3
"""图片 → 64 位差值哈希（dHash），供「同一张单子重拍/换角度」的近重复查重。

算法与 lib/reportIntake.mjs 的 dhash64() **逐位一致**：缩到 9×8 灰度，比较水平相邻像素（左 > 右 记 1）。
（两边必须一致，否则前端算的哈希与 CLI 算的哈希不能互相比较 —— 汉明距离会假阳。）

用法：python3 tools/dhash.py <image.png|jpg>
输出：{ ok, dhash } 或 { ok:false, error }
依赖：Pillow。缺失时返回 ok:false，调用方跳过近重复查重（不影响精确查重）。
"""
import json
import sys


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "用法：python3 tools/dhash.py <image>"}))
        return
    try:
        from PIL import Image
    except Exception:
        print(json.dumps({"ok": False, "error": "缺少 Pillow：pip3 install pillow"}))
        return
    try:
        im = Image.open(sys.argv[1]).convert("L").resize((9, 8))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"读图失败：{e}"}))
        return
    px = list(im.getdata())
    bits = "".join(
        "1" if px[y * 9 + x] > px[y * 9 + x + 1] else "0"
        for y in range(8)
        for x in range(8)
    )
    print(json.dumps({"ok": True, "dhash": bits}))


if __name__ == "__main__":
    main()
