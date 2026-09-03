#!/usr/bin/env python3
"""
Generate and download missing provider logos for 888router.
Ensures every provider in open-sse/providers/registry/ has a corresponding 128x128 PNG in public/providers/.
"""

import os
import sys
import subprocess
import urllib.request
import urllib.error
from PIL import Image

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROVIDERS_DIR = os.path.join(REPO_ROOT, "public", "providers")
TMP_DIR = "/tmp/888router_logos"
os.makedirs(TMP_DIR, exist_ok=True)
os.makedirs(PROVIDERS_DIR, exist_ok=True)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

def download_file(url, dest_path):
    print(f"Downloading: {url} -> {dest_path}")
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=15) as resp, open(dest_path, "wb") as f:
        f.write(resp.read())

def render_svg_to_png(svg_path, png_path, size=128):
    cmd = ["sips", "-s", "format", "png", svg_path, "--out", png_path]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # Ensure exact 128x128
    standardize_png(png_path, size)

def standardize_png(png_path, size=128):
    im = Image.open(png_path)
    im = im.convert("RGBA")
    if im.size != (size, size):
        im = im.resize((size, size), Image.Resampling.LANCZOS)
        im.save(png_path, "PNG")

LOBE_BASE = "https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png@1.95.0/dark"

# 1. Download lobe-icons
LOBE_MAPPINGS = {
    "aihubmix.png": f"{LOBE_BASE}/aihubmix-color.png",
    "baidu.png": f"{LOBE_BASE}/baidu-color.png",
    "featherless.png": f"{LOBE_BASE}/featherless-color.png",
    "fish-audio.png": f"{LOBE_BASE}/fishaudio.png",
    "fishaudio.png": f"{LOBE_BASE}/fishaudio.png",
    "morph.png": f"{LOBE_BASE}/morph-color.png",
    "tencent.png": f"{LOBE_BASE}/hunyuan-color.png",
    "hunyuan.png": f"{LOBE_BASE}/hunyuan-color.png",
    "venice.png": f"{LOBE_BASE}/venice-color.png",
    "zenmux-free.png": f"{LOBE_BASE}/zenmux.png",
    "zenmux.png": f"{LOBE_BASE}/zenmux.png",
    "vercel-ai-gateway.png": f"{LOBE_BASE}/vercel.png",
    "alims-intl.png": f"{LOBE_BASE}/alibabacloud-color.png",
    "alims.png": f"{LOBE_BASE}/alibabacloud-color.png",
    "alitp-intl.png": f"{LOBE_BASE}/alibaba-color.png",
    "alitp.png": f"{LOBE_BASE}/alibaba-color.png",
    "codebuddy-intl.png": f"{LOBE_BASE}/codebuddy-color.png",
    "kilo-gateway.png": f"{LOBE_BASE}/kilocode.png",
}

for filename, url in LOBE_MAPPINGS.items():
    dest = os.path.join(PROVIDERS_DIR, filename)
    tmp = os.path.join(TMP_DIR, filename)
    try:
        download_file(url, tmp)
        standardize_png(tmp, 128)
        # Copy to destination
        im = Image.open(tmp)
        im.save(dest, "PNG")
        print(f"  [OK] {filename}")
    except Exception as e:
        print(f"  [ERR] {filename}: {e}")

# 2. Local re-use / copies
LOCAL_COPIES = {
    "mmf.png": "mimo-free.png",
}
for dest_name, src_name in LOCAL_COPIES.items():
    src_path = os.path.join(PROVIDERS_DIR, src_name)
    dest_path = os.path.join(PROVIDERS_DIR, dest_name)
    if os.path.exists(src_path):
        im = Image.open(src_path)
        im.save(dest_path, "PNG")
        print(f"  [OK-COPY] {dest_name} from {src_name}")

# 3. Direct web downloads
DIRECT_DOWNLOADS = {
    "api-airforce.png": "https://api.airforce/airforce-logo.png",
    "airforce.png": "https://api.airforce/airforce-logo.png",
    "freebuff.png": "https://www.codebuff.com/favicon/apple-touch-icon.png",
    "codebuff.png": "https://www.codebuff.com/favicon/apple-touch-icon.png",
}
for filename, url in DIRECT_DOWNLOADS.items():
    dest = os.path.join(PROVIDERS_DIR, filename)
    tmp = os.path.join(TMP_DIR, filename)
    try:
        download_file(url, tmp)
        standardize_png(tmp, 128)
        im = Image.open(tmp)
        im.save(dest, "PNG")
        print(f"  [OK-WEB] {filename}")
    except Exception as e:
        print(f"  [ERR-WEB] {filename}: {e}")

# 4. Felo icon from ICO
try:
    felo_ico = os.path.join(TMP_DIR, "felo.ico")
    download_file("https://felo.ai/favicon.ico", felo_ico)
    im = Image.open(felo_ico).convert("RGBA")
    felo_png = os.path.join(PROVIDERS_DIR, "felo-web.png")
    im.resize((128, 128), Image.Resampling.LANCZOS).save(felo_png, "PNG")
    im.resize((128, 128), Image.Resampling.LANCZOS).save(os.path.join(PROVIDERS_DIR, "felo.png"), "PNG")
    print("  [OK] felo-web.png & felo.png")
except Exception as e:
    print(f"  [ERR] felo: {e}")

# 5. DuckDuckGo SVG from official duckduckgo.com
try:
    ddg_svg = os.path.join(TMP_DIR, "ddg_raw.svg")
    download_file("https://duckduckgo.com/assets/logo_header.alt.v108.svg", ddg_svg)
    # Render with sips
    ddg_png = os.path.join(PROVIDERS_DIR, "duckduckgo-web.png")
    render_svg_to_png(ddg_svg, ddg_png, 128)
    Image.open(ddg_png).save(os.path.join(PROVIDERS_DIR, "duckduckgo.png"), "PNG")
    Image.open(ddg_png).save(os.path.join(PROVIDERS_DIR, "ddg.png"), "PNG")
    print("  [OK] duckduckgo-web.png & duckduckgo.png")
except Exception as e:
    print(f"  [ERR] duckduckgo: {e}")

# 6. GitLab SVG
gitlab_svg_content = """<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#18181B"/>
  <g transform="translate(24, 24) scale(3.333)">
    <path fill="#FC6D26" d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z"/>
  </g>
</svg>"""
gitlab_svg = os.path.join(TMP_DIR, "gitlab.svg")
with open(gitlab_svg, "w") as f:
    f.write(gitlab_svg_content)
render_svg_to_png(gitlab_svg, os.path.join(PROVIDERS_DIR, "gitlab.png"), 128)
print("  [OK] gitlab.png")

# 7. ChatGPT Web SVG
chatgpt_svg_content = """<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="cg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#10A37F"/>
      <stop offset="100%" stop-color="#059669"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#cg)"/>
  <g transform="translate(26, 26) scale(3.166)" fill="#FFFFFF">
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.259 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7466-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1683a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4947zm-9.66-4.1354a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1402-1.6564zM2.345 9.3853a4.485 4.485 0 0 1 2.3655-1.9729V13.06a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1684a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.345 9.3853zm16.597 3.8558L13.1038 9.8726l2.02-1.1636a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6726a.79.79 0 0 0-.407-.6906zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 10.7197V8.3873a.0663.0663 0 0 1 .0284-.0615l4.8304-2.7866a4.4992 4.4992 0 0 1 6.6802 4.6672zm-12.6413 4.783-2.02-1.1636a.0804.0804 0 0 1-.038-.052V8.0023a4.504 4.504 0 0 1 7.371-3.4537l-.142.0805-4.7783 2.7582a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>
  </g>
</svg>"""
chatgpt_svg = os.path.join(TMP_DIR, "chatgpt.svg")
with open(chatgpt_svg, "w") as f:
    f.write(chatgpt_svg_content)
render_svg_to_png(chatgpt_svg, os.path.join(PROVIDERS_DIR, "chatgpt-web.png"), 128)
Image.open(os.path.join(PROVIDERS_DIR, "chatgpt-web.png")).save(os.path.join(PROVIDERS_DIR, "chatgpt.png"), "PNG")
print("  [OK] chatgpt-web.png & chatgpt.png")

# 8. AiPASS TH (Thai AI Passport) SVG
aipass_svg_content = """<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="ap_bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1E3A8A"/>
      <stop offset="50%" stop-color="#0F172A"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
    <linearGradient id="ap_gold" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FDE047"/>
      <stop offset="50%" stop-color="#EAB308"/>
      <stop offset="100%" stop-color="#CA8A04"/>
    </linearGradient>
    <linearGradient id="ap_red" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#EF4444"/>
      <stop offset="100%" stop-color="#B91C1C"/>
    </linearGradient>
  </defs>
  <rect x="6" y="6" width="116" height="116" rx="26" fill="url(#ap_bg)" stroke="url(#ap_gold)" stroke-width="2.5"/>
  <rect x="28" y="20" width="72" height="3" rx="1.5" fill="url(#ap_red)"/>
  <rect x="36" y="25" width="56" height="2" rx="1" fill="#FFFFFF" opacity="0.85"/>
  <rect x="42" y="29" width="44" height="3" rx="1.5" fill="#3B82F6"/>
  <circle cx="64" cy="60" r="19" fill="none" stroke="url(#ap_gold)" stroke-width="2.5"/>
  <path d="M64 45 L64 75 M49 60 L79 60" stroke="url(#ap_gold)" stroke-width="1.5" stroke-dasharray="2,2"/>
  <circle cx="64" cy="60" r="9" fill="url(#ap_gold)"/>
  <circle cx="64" cy="60" r="4.5" fill="#0F172A"/>
  <text x="64" y="103" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="16" font-weight="900" fill="#FFFFFF" text-anchor="middle" letter-spacing="1.5">AiPASS</text>
  <text x="64" y="115" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="8" font-weight="700" fill="#EAB308" text-anchor="middle" letter-spacing="1">THAILAND</text>
</svg>"""
aipass_svg = os.path.join(TMP_DIR, "aipass.svg")
with open(aipass_svg, "w") as f:
    f.write(aipass_svg_content)
render_svg_to_png(aipass_svg, os.path.join(PROVIDERS_DIR, "aipass.png"), 128)
print("  [OK] aipass.png")

# 9. Bazaarlink SVG
bazaarlink_svg_content = """<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bl_bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#DC2626"/>
      <stop offset="100%" stop-color="#7F1D1D"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#bl_bg)"/>
  <g transform="translate(24, 20)" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 28 L40 8 L76 28 L76 68 L4 68 Z"/>
    <path d="M4 28 L76 28"/>
    <path d="M40 8 L40 68"/>
    <circle cx="40" cy="48" r="10" fill="#FFFFFF"/>
    <circle cx="40" cy="48" r="4" fill="#DC2626"/>
  </g>
  <text x="64" y="112" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="900" fill="#FFFFFF" text-anchor="middle" letter-spacing="1.5">BAZAARLINK</text>
</svg>"""
bazaarlink_svg = os.path.join(TMP_DIR, "bazaarlink.svg")
with open(bazaarlink_svg, "w") as f:
    f.write(bazaarlink_svg_content)
render_svg_to_png(bazaarlink_svg, os.path.join(PROVIDERS_DIR, "bazaarlink.png"), 128)
print("  [OK] bazaarlink.png")

# 10. BluesMinds SVG
bluesminds_svg_content = """<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bm_bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3B82F6"/>
      <stop offset="100%" stop-color="#1E3A8A"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#bm_bg)"/>
  <g transform="translate(26, 20)" fill="none" stroke="#FFFFFF" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="38" cy="20" r="6" fill="#FFFFFF"/>
    <circle cx="16" cy="38" r="5" fill="#FFFFFF"/>
    <circle cx="60" cy="38" r="5" fill="#FFFFFF"/>
    <circle cx="24" cy="58" r="5" fill="#FFFFFF"/>
    <circle cx="52" cy="58" r="5" fill="#FFFFFF"/>
    <circle cx="38" cy="44" r="7" fill="#60A5FA"/>
    <line x1="38" y1="20" x2="16" y2="38"/>
    <line x1="38" y1="20" x2="60" y2="38"/>
    <line x1="16" y1="38" x2="38" y2="44"/>
    <line x1="60" y1="38" x2="38" y2="44"/>
    <line x1="38" y1="44" x2="24" y2="58"/>
    <line x1="38" y1="44" x2="52" y2="58"/>
    <line x1="24" y1="58" x2="52" y2="58"/>
  </g>
  <text x="64" y="112" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="13" font-weight="900" fill="#FFFFFF" text-anchor="middle" letter-spacing="1.5">BLUESMINDS</text>
</svg>"""
bluesminds_svg = os.path.join(TMP_DIR, "bluesminds.svg")
with open(bluesminds_svg, "w") as f:
    f.write(bluesminds_svg_content)
render_svg_to_png(bluesminds_svg, os.path.join(PROVIDERS_DIR, "bluesminds.png"), 128)
print("  [OK] bluesminds.png")

# 11. LLM7 SVG
llm7_svg_content = """<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="l7_bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#8B5CF6"/>
      <stop offset="100%" stop-color="#4C1D95"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#l7_bg)"/>
  <g transform="translate(24, 20)">
    <circle cx="40" cy="36" r="28" fill="none" stroke="#C4B5FD" stroke-width="2.5" opacity="0.6"/>
    <circle cx="40" cy="36" r="18" fill="none" stroke="#DDD6FE" stroke-width="2.5" opacity="0.8"/>
    <text x="40" y="47" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="30" font-weight="900" fill="#FFFFFF" text-anchor="middle">7</text>
  </g>
  <text x="64" y="112" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="16" font-weight="900" fill="#FFFFFF" text-anchor="middle" letter-spacing="2">LLM7</text>
</svg>"""
llm7_svg = os.path.join(TMP_DIR, "llm7.svg")
with open(llm7_svg, "w") as f:
    f.write(llm7_svg_content)
render_svg_to_png(llm7_svg, os.path.join(PROVIDERS_DIR, "llm7.png"), 128)
print("  [OK] llm7.png")

# 12. CheaperInference SVG
ci_svg_content = """<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="ci_bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#A855F7"/>
      <stop offset="100%" stop-color="#581C87"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#ci_bg)"/>
  <g transform="translate(24, 18)" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 52 L32 30 L48 44 L70 16"/>
    <polyline points="54 16 70 16 70 32"/>
    <circle cx="10" cy="52" r="3" fill="#FFFFFF"/>
    <circle cx="32" cy="30" r="3" fill="#FFFFFF"/>
    <circle cx="48" cy="44" r="3" fill="#FFFFFF"/>
    <circle cx="70" cy="16" r="3" fill="#FACC15"/>
  </g>
  <text x="64" y="104" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="12" font-weight="900" fill="#FFFFFF" text-anchor="middle" letter-spacing="1">CHEAPER</text>
  <text x="64" y="117" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="9" font-weight="700" fill="#E9D5FF" text-anchor="middle" letter-spacing="1">INFERENCE</text>
</svg>"""
ci_svg = os.path.join(TMP_DIR, "cheaperinference.svg")
with open(ci_svg, "w") as f:
    f.write(ci_svg_content)
render_svg_to_png(ci_svg, os.path.join(PROVIDERS_DIR, "cheaperinference.png"), 128)
Image.open(os.path.join(PROVIDERS_DIR, "cheaperinference.png")).save(os.path.join(PROVIDERS_DIR, "cheap-inf.png"), "PNG")
print("  [OK] cheaperinference.png & cheap-inf.png")

# 13. Selfhosted Embedding SVG
embed_svg_content = """<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="emb_bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0D9488"/>
      <stop offset="100%" stop-color="#042F2E"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#emb_bg)"/>
  <g transform="translate(24, 20)" fill="none" stroke="#FFFFFF" stroke-width="2.5">
    <polygon points="40 10 72 26 40 42 8 26" fill="#14B8A6" opacity="0.7"/>
    <polygon points="40 26 72 42 40 58 8 42" fill="#0F766E" opacity="0.8"/>
    <polygon points="40 42 72 58 40 74 8 58" fill="#115E59"/>
    <circle cx="40" cy="26" r="3" fill="#FFFFFF"/>
    <circle cx="40" cy="42" r="3" fill="#FFFFFF"/>
    <circle cx="40" cy="58" r="3" fill="#2DD4BF"/>
  </g>
  <text x="64" y="112" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="11" font-weight="900" fill="#FFFFFF" text-anchor="middle" letter-spacing="1">EMBEDDING</text>
</svg>"""
embed_svg = os.path.join(TMP_DIR, "selfhosted_embedding.svg")
with open(embed_svg, "w") as f:
    f.write(embed_svg_content)
render_svg_to_png(embed_svg, os.path.join(PROVIDERS_DIR, "selfhosted-embedding.png"), 128)
print("  [OK] selfhosted-embedding.png")

# 14. Selfhosted STT SVG
stt_svg_content = """<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="stt_bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#EA580C"/>
      <stop offset="100%" stop-color="#7C2D12"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#stt_bg)"/>
  <g transform="translate(34, 18)" fill="none" stroke="#FFFFFF" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
    <rect x="18" y="8" width="24" height="38" rx="12" fill="#FFFFFF"/>
    <path d="M8 30 C8 46 52 46 52 30"/>
    <line x1="30" y1="46" x2="30" y2="58"/>
    <line x1="18" y1="58" x2="42" y2="58"/>
  </g>
  <text x="64" y="99" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="900" fill="#FFFFFF" text-anchor="middle" letter-spacing="1.5">SPEECH</text>
  <text x="64" y="114" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="10" font-weight="700" fill="#FED7AA" text-anchor="middle" letter-spacing="1">TO TEXT (STT)</text>
</svg>"""
stt_svg = os.path.join(TMP_DIR, "selfhosted_stt.svg")
with open(stt_svg, "w") as f:
    f.write(stt_svg_content)
render_svg_to_png(stt_svg, os.path.join(PROVIDERS_DIR, "selfhosted-stt.png"), 128)
print("  [OK] selfhosted-stt.png")

# 15. Selfhosted TTS SVG
tts_svg_content = """<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="tts_bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#4F46E5"/>
      <stop offset="100%" stop-color="#1E1B4B"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#tts_bg)"/>
  <g transform="translate(24, 18)" fill="none" stroke="#FFFFFF" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="12 44 26 44 44 58 44 14 26 28 12 28" fill="#FFFFFF"/>
    <path d="M54 24 C60 30 60 42 54 48"/>
    <path d="M62 16 C72 26 72 46 62 56"/>
  </g>
  <text x="64" y="99" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="14" font-weight="900" fill="#FFFFFF" text-anchor="middle" letter-spacing="1.5">TEXT</text>
  <text x="64" y="114" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="10" font-weight="700" fill="#C7D2FE" text-anchor="middle" letter-spacing="1">TO SPEECH (TTS)</text>
</svg>"""
tts_svg = os.path.join(TMP_DIR, "selfhosted_tts.svg")
with open(tts_svg, "w") as f:
    f.write(tts_svg_content)
render_svg_to_png(tts_svg, os.path.join(PROVIDERS_DIR, "selfhosted-tts.png"), 128)
print("  [OK] selfhosted-tts.png")

print("\n--- Summary Verification ---")
from glob import glob
missing_count = 0
all_providers = [
    "aihubmix", "aipass", "alims-intl", "alitp-intl", "api-airforce", "baidu",
    "bazaarlink", "bluesminds", "chatgpt-web", "cheaperinference", "codebuddy-intl",
    "duckduckgo-web", "featherless", "felo-web", "fish-audio", "freebuff",
    "gitlab", "kilo-gateway", "llm7", "mmf", "morph", "selfhosted-embedding",
    "selfhosted-stt", "selfhosted-tts", "tencent", "venice", "vercel-ai-gateway",
    "zenmux-free"
]

for p in all_providers:
    target = os.path.join(PROVIDERS_DIR, f"{p}.png")
    if os.path.exists(target):
        im = Image.open(target)
        print(f"PASS: {p}.png ({im.size}, {im.mode})")
    else:
        print(f"FAIL: {p}.png is missing!")
        missing_count += 1

print(f"\nCompleted! Missing: {missing_count} / {len(all_providers)}")
if missing_count > 0:
    sys.exit(1)
