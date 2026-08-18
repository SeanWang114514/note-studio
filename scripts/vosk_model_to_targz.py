#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 alphacephei 官方 vosk 模型 .zip 转成 vosk-browser 需要的 .tar.gz
=================================================================
vosk-browser 只接受 gzipped tar 格式的模型包，且要求包内有 model/conf/model.conf
（官方 zip 里没有这个文件，本脚本会自动补上）。

用法：
    # 本地 zip
    python scripts/vosk_model_to_targz.py vosk-model-small-cn-0.22.zip
    # 直接下载官方模型再转换（默认输出到 public/models/）
    python scripts/vosk_model_to_targz.py https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip

参数：
    --out    输出 .tar.gz 路径（默认 public/models/<zip名>.tar.gz）
    --name   包内顶层目录名（默认 model，与 vosk-browser 约定一致）

转换完成后把 public/models/ 里的 .tar.gz 填到语音识别弹窗的模型地址即可
（dev 下 Vite 直接提供 /models/xxx.tar.gz，注意模型文件需要 HTTP 服务）。
"""
import argparse
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

MODEL_CONF_DEFAULT = """--min-active=200
--max-active=3000
--beam=13.0
--lattice-beam=6.0
--acoustic-scale=1.0
--endpoint.silence_phones=1:2:3:4:5
--endpoint.silence_probability=0.5
--endpoint.silence_trigger=10
"""

REQUIRED = [
    ("am", "final.mdl"),
    ("conf", "mfcc.conf"),
]
# graph 目录：small 模型用 HCLr.fst + Gr.fst（在线识别图），大模型用 HCLG.fst
GRAPH_ANY = ["HCLr.fst", "Gr.fst", "HCLG.fst"]


def find_model_root(directory):
    """在解压目录里找到包含 am/final.mdl 的模型根目录。"""
    for root, dirs, files in os.walk(directory):
        if "final.mdl" in files and os.path.basename(root) == "am":
            parent = os.path.dirname(root)
            if os.path.isfile(os.path.join(parent, "graph", "words.txt")):
                return parent
    # 兜底：直接找含 am/final.mdl 的目录
    for root, dirs, files in os.walk(directory):
        if os.path.isfile(os.path.join(root, "am", "final.mdl")):
            return root
    return None


def ensure_model_conf(model_root):
    conf_dir = os.path.join(model_root, "conf")
    os.makedirs(conf_dir, exist_ok=True)
    conf_path = os.path.join(conf_dir, "model.conf")
    if not os.path.isfile(conf_path):
        with open(conf_path, "w", encoding="utf-8") as f:
            f.write(MODEL_CONF_DEFAULT)
        print(f"[vosk] 已生成缺失的 {conf_path}")
    # 官方模型可能是 hires 版，mfcc_hires.conf 优先
    hires = os.path.join(conf_dir, "mfcc_hires.conf")
    if os.path.isfile(hires) and not os.path.isfile(os.path.join(conf_dir, "mfcc.conf")):
        shutil.copyfile(hires, os.path.join(conf_dir, "mfcc.conf"))


def make_targz(model_root, out_path, arcname):
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with tarfile.open(out_path, "w:gz") as tar:
        tar.add(model_root, arcname=arcname)
    print(f"[vosk] 已生成 {out_path}")


def main():
    parser = argparse.ArgumentParser(description="vosk 模型 zip -> tar.gz 转换")
    parser.add_argument("source", help="zip 文件路径或下载 URL")
    parser.add_argument("--out", default=None, help="输出 .tar.gz 路径")
    parser.add_argument("--name", default="model", help="包内顶层目录名（默认 model）")
    args = parser.parse_args()

    src = args.source
    tmp = tempfile.mkdtemp(prefix="vosk_conv_")
    try:
        if src.startswith(("http://", "https://")):
            zip_path = os.path.join(tmp, "model.zip")
            print(f"[vosk] 正在下载 {src} …")
            urllib.request.urlretrieve(src, zip_path)
        else:
            if not os.path.isfile(src):
                sys.exit(f"找不到文件：{src}")
            zip_path = os.path.abspath(src)

        print("[vosk] 解压 zip …")
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(tmp)

        model_root = find_model_root(tmp)
        if not model_root:
            sys.exit("无法在 zip 中找到模型（缺少 am/final.mdl）")

        missing = [
            f"{d}/{f}" for d, f in REQUIRED if not os.path.isfile(os.path.join(model_root, d, f))
        ]
        graph_dir = os.path.join(model_root, "graph")
        if not missing and not any(
            os.path.isfile(os.path.join(graph_dir, f)) for f in GRAPH_ANY
        ):
            missing.append("graph/" + "/".join(GRAPH_ANY))
        if missing:
            sys.exit("模型缺少必需文件：" + ", ".join(missing))

        ensure_model_conf(model_root)

        base = os.path.splitext(os.path.basename(src))[0]
        if base.endswith(".tar"):
            base = base[: -len(".tar")]
        out = args.out or os.path.join("public", "models", base + ".tar.gz")
        make_targz(model_root, out, args.name)
        rel = out.replace("\\", "/").lstrip("./")
        url = "/" + rel[len("public/"):] if rel.startswith("public/") else "/" + rel
        print("[vosk] 完成！在语音识别弹窗的模型地址填入：" + url)
        print(f"[vosk] 已生成：{out}（需通过 HTTP 提供，如放 public/models/ 则由前端 /models/ 直接访问）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()