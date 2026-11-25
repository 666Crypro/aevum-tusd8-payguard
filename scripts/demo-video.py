#!/usr/bin/env python3
"""Compose docs/demo.mp4 (1080p H.264 + AAC, Piper TTS narration) from real captured output."""
from __future__ import annotations
import os, re, shutil, subprocess, wave
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
LOGS = ROOT / "docs" / "demo-logs"
OUT = ROOT / "docs" / "demo.mp4"
WORK = Path(os.environ.get("DEMO_WORK", "/workspace/qday-video-work/frames"))
PIPER = os.environ.get("PIPER", "/workspace/tools-video/piper/piper")
VOICE = os.environ.get("VOICE", "/workspace/tools-video/en_US-lessac-medium.onnx")
W, H = 1920, 1080
LEAD, TAIL = 0.12, 0.28

GF = "/usr/share/fonts/truetype/sand-box/google"
INTER = f"{GF}/Inter/Inter-VariableFont_opsz,wght.ttf"
MONO = f"{GF}/JetBrains Mono/JetBrainsMono-VariableFont_wght.ttf"
FALLBACK = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
MONO_CMAP = TTFont(MONO).getBestCmap()

def font(path, size, wght=None):
    f = ImageFont.truetype(path, size)
    if wght is not None:
        try:
            f.set_variation_by_axes([wght] if path == MONO else [14, wght])
        except Exception:
            pass
    return f

BG = (11, 15, 23); PANEL = (21, 27, 38); BORDER = (38, 48, 65)
FG = (230, 237, 243); DIM = (139, 148, 158); CYAN = (88, 196, 220); GREEN = (63, 185, 80)
RED = (248, 81, 73); YELLOW = (227, 179, 65); BLUE = (88, 166, 255)

def read_lines(name):
    return (LOGS / name).read_text().splitlines()

demo = read_lines("demo.txt")
def section(start, end=None):
    i = next(k for k, l in enumerate(demo) if l.startswith(f"== {start}."))
    j = len(demo) if end is None else next(k for k, l in enumerate(demo) if l.startswith(f"== {end}."))
    out = demo[i:j]
    while out and not out[-1].strip():
        out.pop()
    return out

unit = [l for l in read_lines("forge-unit.txt") if l.startswith(("[PASS]", "Suite result", "Ran 14"))]
unit = [re.sub(r" \((gas|runs).*\)$", "", l) if l.startswith("[PASS]") else l for l in unit]
fork = [l for l in read_lines("forge-fork.txt") if l.strip() and not l.startswith(("No files", "Compiling"))]
npmt = [l for l in read_lines("npm-test.txt") if l.startswith(("✔", "ℹ tests", "ℹ pass", "ℹ fail"))]

def color_for(line):
    s = line.strip()
    if s.startswith("=="): return CYAN
    if "REVERTED" in s or "REFUSED" in s: return RED
    if "SETTLED" in s or s.startswith(("[PASS]", "✔", "Suite result", "Demo complete")) or "skippedZero=1" in s: return GREEN
    if s.startswith("$"): return BLUE
    if s.startswith("ERC-681"): return YELLOW
    return FG

F_MONO = {}
def mono(size, bold=False):
    k = (size, bold)
    if k not in F_MONO:
        F_MONO[k] = (font(MONO, size, 700 if bold else 430), ImageFont.truetype(FALLBACK, int(size * 0.9)))
    return F_MONO[k]

def draw_mono(d, xy, text, size, fill, bold=False):
    f, fb = mono(size, bold)
    x, y = xy
    cw = f.getlength("M")
    for ch in text:
        if ord(ch) in MONO_CMAP or ch == " ":
            d.text((x, y), ch, font=f, fill=fill)
        else:
            d.text((x, y + 1), ch, font=fb, fill=fill)
        x += cw

def wrap(line, maxc):
    if len(line) <= maxc:
        return [line]
    ind = len(line) - len(line.lstrip()) + 4
    out, cur = [], line
    while len(cur) > maxc:
        cut = cur.rfind(" ", 0, maxc)
        if cut <= ind:
            cut = maxc
        out.append(cur[:cut]); cur = " " * ind + cur[cut:].lstrip()
    out.append(cur)
    return out

def header(d, kicker, title):
    d.text((64, 34), kicker.upper(), font=font(INTER, 22, 700), fill=CYAN)
    d.text((64, 62), title, font=font(INTER, 40, 700), fill=FG)

def window(img, box, title):
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = box
    d.rounded_rectangle(box, 14, fill=PANEL, outline=BORDER, width=2)
    d.rounded_rectangle((x0, y0, x1, y0 + 42), 14, fill=(30, 37, 50))
    d.rectangle((x0, y0 + 28, x1, y0 + 42), fill=(30, 37, 50))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse((x0 + 18 + i * 24, y0 + 14, x0 + 32 + i * 24, y0 + 28), fill=c)
    d.text((x0 + 100, y0 + 10), title, font=font(INTER, 20, 500), fill=DIM)
    return (x0 + 24, y0 + 60, x1 - 24, y1 - 16)

def term_frame(kicker, title, panes, shown):
    img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
    header(d, kicker, title)
    left = shown
    for box, wt, lines, size in panes:
        ix0, iy0, ix1, iy1 = window(img, box, wt)
        f, _ = mono(size)
        maxc = int((ix1 - ix0) / f.getlength("M"))
        vis = [(seg, color_for(l), l.strip().startswith("==")) for l in lines for seg in wrap(l, maxc)]
        lh = int(size * 1.42)
        for k, (seg, c, b) in enumerate(vis[: max(0, left)]):
            draw_mono(d, (ix0, iy0 + k * lh), seg, size, c, bold=b)
        assert iy0 + len(vis) * lh <= iy1 + 4, f"overflow in {title}: {len(vis)} lines"
        left -= len(vis)
    return img

def count_vis(panes):
    n = 0
    for box, wt, lines, size in panes:
        f, _ = mono(size); maxc = int((box[2] - box[0] - 48) / f.getlength("M"))
        n += sum(len(wrap(l, maxc)) for l in lines)
    return n

def card(lines):
    img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
    total = sum(h for _, _, _, h in lines)
    y = (H - total) // 2
    for text, f, c, h in lines:
        if text:
            tw = d.textlength(text, font=f)
            d.text(((W - tw) / 2, y), text, font=f, fill=c)
        y += h
    return img

def image_frame(kicker, title, path, wintitle):
    img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
    header(d, kicker, title)
    ix0, iy0, ix1, iy1 = window(img, (60, 140, 1860, 1040), wintitle)
    src = Image.open(path).convert("RGB")
    s = min((ix1 - ix0) / src.width, (iy1 - iy0) / src.height)
    src = src.resize((int(src.width * s), int(src.height * s)), Image.LANCZOS)
    img.paste(src, (ix0 + (ix1 - ix0 - src.width) // 2, iy0 + (iy1 - iy0 - src.height) // 2))
    return img

DEMO_WIN = "app — npm run demo  (local Anvil fork of QDay Aevum Testnet · Chain ID 44005 · real tUSD8)"
FULL = (60, 140, 1860, 1040)
T1, T2 = font(INTER, 92, 800), font(INTER, 38, 500)
T3, T4 = font(INTER, 28, 500), font(INTER, 24, 400)

SCENES = [
    dict(kind="card", lines=[
        ("tUSD8 PayGuard", T1, FG, 125),
        ("Verified Invoicing, Milestone Escrow & Policy-Bounded Agent Clearinghouse", T2, CYAN, 76),
        ("QDay Aevum Builder Challenge #1  ·  Chain ID 44005  ·  Official tUSD8 (6 decimals)", T3, DIM, 48),
    ], vo="Accepting stablecoins in production breaks when decimals get mixed up, addresses are spoofed, "
          "or an AI agent holds raw wallet keys. t U S D 8 PayGuard solves all three on QDay Aevum."),

    dict(kind="image", kicker="Architecture", title="Two modular contracts + an honest chain watcher on Aevum (Chain ID 44005)",
         path="docs/arch.png", wintitle="System Architecture — PayeeRegistry + TUSD8PayGuard + Honest Watcher",
         vo="PayeeRegistry provides on-chain Confirmation of Payee before any funds move. T U S D 8 PayGuard "
            "pins the six-decimal t U S D 8 token at deploy time, handles instant or milestone escrow invoices, "
            "and enforces per-transaction caps, daily limits, and instant revocation for autonomous agents."),

    dict(kind="term", kicker="Tests · Verified Locally", title="14 Foundry unit + 512 fuzz runs, Aevum fork test, and Node suite",
         panes=[
             ((60, 140, 940, 1040), "contracts — forge test", ["$ forge test --no-match-contract Fork -vv"] + unit, 18),
             ((970, 140, 1860, 1040), "fork + app tests",
              ["$ forge test --match-contract Fork -vv"] + fork + ["", "$ cd ../app && npm test"] + npmt, 16),
         ],
         vo="All fourteen Foundry unit and fuzz tests pass, including five hundred twelve fuzz runs over partial escrow splits. "
            "The fork test runs end to end against the real t U S D 8 contract on QDay Aevum testnet, and all four Node tests pass."),

    dict(kind="term", kicker="Live Fork Walkthrough · Steps 1 to 4", title="Fork Aevum 44005, enforce Confirmation of Payee, and release milestones",
         panes=[(FULL, DEMO_WIN, ["$ npm run demo"] + section(1, 5), 18)],
         vo="In the live demo, we fork QDay Aevum at chain I D forty-four thousand five, create a forty-token escrow invoice "
            "with an E R C six eighty-one payment request pinned to Aevum, verify that a wrong payee label reverts on chain, "
            "and release two milestones of fifteen and twenty-five tokens."),

    dict(kind="term", kicker="Live Fork Walkthrough · Steps 5 & 6", title="Scoped agent session keys block attacks; watcher drops zero-value spam",
         panes=[(FULL, DEMO_WIN, section(5), 18)],
         vo="Next, an autonomous agent executes an eighteen point five token payment with an on-chain reason hash. "
            "When prompted to pay an unverified address or exceed its twenty-token cap, the contract refuses. "
            "One transaction revokes the key, and our chain watcher drops a zero-value transfer spoof probe."),

    dict(kind="image", kicker="Web Interface · Invoicing & QR", title="Responsive UI with 6-decimal integer preview and ERC-681 QR codes",
         path="docs/ui-overview.png", wintitle="http://127.0.0.1:8788 — Invoices, Milestone Escrow & ERC-681 QR",
         vo="The web interface gives merchants live six-decimal base-unit previews, scannable E R C six eighty-one Q R codes, "
            "one-click network addition for MetaMask, and instant milestone release controls."),

    dict(kind="image", kicker="Web Interface · Agent Security", title="Interactive session policy controls and live attack simulations",
         path="docs/ui-agent.png", wintitle="http://127.0.0.1:8788 — AI Agent Session Keys & Attack Simulator",
         vo="In the agent security console, operators set per-transaction and daily caps, simulate prompt-injection attacks, "
            "see exact on-chain revert reasons, and revoke compromised session keys in one click."),

    dict(kind="card", lines=[
        ("tUSD8 PayGuard", font(INTER, 80, 800), FG, 115),
        ("github.com/666Crypro/aevum-tusd8-payguard", font(INTER, 42, 600), BLUE, 84),
        ("Reproduce locally:  forge test   ·   npm test   ·   npm run demo   ·   docker compose up", T3, FG, 68),
        ("Built for QDay Aevum Builder Challenge #1 (Chain ID 44005 · Official tUSD8)", T4, DIM, 44),
        ("MIT Licensed · Unaudited hackathon prototype · Fork & testnet demo uses test tokens only", T4, DIM, 44),
    ], vo="t U S D 8 PayGuard on QDay Aevum testnet. All source code, Docker configuration, and reproduction commands are "
          "available in the public repository shown on screen. Thanks for watching."),
]

def tts(i, text):
    p = WORK / f"vo{i:02d}.wav"
    subprocess.run([PIPER, "--model", VOICE, "--output_file", str(p), "--sentence_silence", "0.22"],
                   input=text.encode(), check=True, capture_output=True)
    with wave.open(str(p)) as w:
        return p, w.getnframes() / w.getframerate(), w.getparams()

def main():
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)
    os.chdir(ROOT)
    clips = [tts(i, s["vo"]) for i, s in enumerate(SCENES)]
    params = clips[0][2]; rate = params.framerate
    pcm = bytearray(); concat = []; t = 0.0; marks = []

    def silence(sec):
        return b"\x00\x00" * int(round(sec * rate)) * params.nchannels

    for i, (s, (p, dur, _)) in enumerate(zip(SCENES, clips)):
        seg = LEAD + dur + TAIL
        with wave.open(str(p)) as w:
            pcm += silence(LEAD) + w.readframes(w.getnframes()) + silence(TAIL)
        marks.append((t, seg, s.get("title") or s["lines"][0][0]))
        if s["kind"] == "card":
            frames = [(card(s["lines"]), seg)]
        elif s["kind"] == "image":
            frames = [(image_frame(s["kicker"], s["title"], s["path"], s["wintitle"]), seg)]
        else:
            n = count_vis(s["panes"])
            reveal = min(dur * 0.72, max(2.0, n * 0.12))
            steps = min(n, 28)
            per = reveal / steps
            frames = []
            for k in range(1, steps + 1):
                shown = round(n * k / steps)
                frames.append((term_frame(s["kicker"], s["title"], s["panes"], shown), per if k < steps else seg - reveal + per))
        for j, (img, d) in enumerate(frames):
            fp = WORK / f"s{i:02d}_{j:03d}.png"
            img.save(fp)
            concat.append((fp, d))
        t += seg

    with wave.open(str(WORK / "narration.wav"), "wb") as w:
        w.setparams(params); w.writeframes(bytes(pcm))
    with open(WORK / "frames.txt", "w") as f:
        for fp, d in concat:
            f.write(f"file '{fp}'\nduration {d:.4f}\n")
        f.write(f"file '{concat[-1][0]}'\n")
    for st, seg, name in marks:
        print(f"{st:7.2f}s  +{seg:5.2f}s  {name}")
    subprocess.check_call([
        "ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(WORK / "frames.txt"),
        "-i", str(WORK / "narration.wav"), "-vf", "fps=30,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-tune", "stillimage",
        "-af", "loudnorm=I=-16:LRA=11:TP=-1.5", "-ar", "48000", "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart", "-t", f"{t:.3f}", str(OUT)
    ])
    print(f"wrote {OUT} {t:.2f}s {OUT.stat().st_size/1e6:.2f} MB")

if __name__ == "__main__":
    main()
