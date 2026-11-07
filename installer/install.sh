#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  NIGHTLINE · Railway — نصب‌کنندهٔ خودکار
#
#  این اسکریپت آخرین نسخهٔ مخزن را می‌گیرد، یک پروژهٔ Railway می‌سازد،
#  سرویس را دیپلوی می‌کند، متغیرها را می‌گذارد و آدرس پنل را چاپ می‌کند.
#
#  پیش‌نیازها: git ،node ≥ 20 ،curl  (Railway CLI خودکار نصب می‌شود)
#  اجرا:       bash installer/install.sh
#  ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_URL="${NIGHTLINE_REPO:-https://github.com/youdidking/NightLine-Railway}"
PROJECT_NAME="${NIGHTLINE_PROJECT:-nightline-railway}"
WORKDIR="${NIGHTLINE_DIR:-$PWD/nightline-railway}"
PANEL_PORT="${NL_PANEL_PORT:-8080}"
TCP_PORT="${NL_TCP_PORT:-8443}"

c_dim() { printf '\033[2m%s\033[0m\n' "$*"; }
c_ok()  { printf '\033[1m✔ %s\033[0m\n' "$*"; }
c_warn(){ printf '\033[1m! %s\033[0m\n' "$*"; }
c_err() { printf '\033[1m✗ %s\033[0m\n' "$*" >&2; }
step()  { printf '\n\033[1m── %s\033[0m\n' "$*"; }

need() { command -v "$1" >/dev/null 2>&1; }

# ── 0. پیش‌نیازها ────────────────────────────────────────────────────────────
step "بررسی پیش‌نیازها"
need git  || { c_err "git نصب نیست. نصبش کن و دوباره اجرا کن."; exit 1; }
need node || { c_err "Node.js نسخهٔ ۲۰ یا بالاتر لازم است: https://nodejs.org"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then c_err "Node.js شما $NODE_MAJOR است، حداقل ۲۰ لازم است."; exit 1; fi
c_ok "git و Node.js $(node -v) آماده‌اند"

if ! need railway; then
  c_warn "Railway CLI نصب نیست؛ نصب می‌شود (npm i -g @railway/cli)…"
  npm install -g @railway/cli >/dev/null 2>&1 || {
    c_err "نصب CLI نشد. دستی اجرا کن: npm i -g @railway/cli"
    exit 1
  }
fi
c_ok "Railway CLI: $(railway --version 2>/dev/null || echo installed)"

# ── 1. توکن ──────────────────────────────────────────────────────────────────
step "ورود به حساب Railway"
cat <<'TXT'
  برای گرفتن توکن:
    ۱) وارد https://railway.com/dashboard شو
    ۲) Account Settings → Tokens → Create Token
    ۳) یک نام بده (مثلاً nightline) و توکن را کپی کن
  توکن فقط روی همین دستگاه در متغیر محیطی RAILWAY_TOKEN استفاده می‌شود،
  در هیچ فایلی ذخیره یا چاپ نمی‌شود.
TXT

if [ -z "${RAILWAY_TOKEN:-}" ]; then
  if [ -t 0 ]; then
    printf '\n  توکن Railway را بچسبان (نمایش داده نمی‌شود): '
    read -rs RAILWAY_TOKEN
    printf '\n'
  else
    c_err "RAILWAY_TOKEN تنظیم نیست و ورودی تعاملی هم نداریم."
    echo "  مثال:  RAILWAY_TOKEN=xxxx bash installer/install.sh"
    exit 1
  fi
fi
[ -n "${RAILWAY_TOKEN:-}" ] || { c_err "توکن خالی است."; exit 1; }
export RAILWAY_TOKEN

if railway whoami >/dev/null 2>&1; then
  c_ok "اتصال به حساب برقرار شد"
else
  c_err "توکن پذیرفته نشد. مطمئن شو از Account Settings → Tokens گرفته شده."
  exit 1
fi

# ── 2. آخرین نسخهٔ مخزن ──────────────────────────────────────────────────────
step "گرفتن آخرین نسخهٔ پروژه"
if [ -d "$WORKDIR/.git" ]; then
  c_dim "پوشهٔ موجود به‌روزرسانی می‌شود: $WORKDIR"
  git -C "$WORKDIR" fetch --depth 1 origin
  git -C "$WORKDIR" reset --hard origin/HEAD >/dev/null
else
  c_dim "کلون در: $WORKDIR"
  git clone --depth 1 "$REPO_URL" "$WORKDIR"
fi
[ -f "$WORKDIR/Dockerfile" ] || { c_err "Dockerfile در مخزن پیدا نشد — آدرس مخزن را چک کن."; exit 1; }
c_ok "نسخهٔ $(node -p "require('$WORKDIR/package.json').version") از مخزن آماده است"

# ── 3. پروژه و سرویس ────────────────────────────────────────────────────────
step "ساخت پروژه در Railway"
cd "$WORKDIR"

if [ -n "${RAILWAY_PROJECT_ID:-}" ]; then
  railway link --project "$RAILWAY_PROJECT_ID" >/dev/null 2>&1 || true
  c_ok "به پروژهٔ موجود لینک شد"
elif [ -f .railway/config.json ] || railway status >/dev/null 2>&1; then
  c_ok "این پوشه از قبل به یک پروژه وصل است"
else
  c_dim "پروژهٔ تازه ساخته می‌شود: $PROJECT_NAME"
  if ! railway init --name "$PROJECT_NAME" >/dev/null 2>&1; then
    c_warn "ساخت خودکار پروژه نشد. یک‌بار دستی اجرا کن:  railway init  — بعد این اسکریپت را تکرار کن."
  fi
fi

# ── 4. متغیرها ──────────────────────────────────────────────────────────────
step "تنظیم متغیرها"
railway variables \
  --set "PORT=$PANEL_PORT" \
  --set "NL_TCP_PORT=$TCP_PORT" \
  --set "NL_PANEL_PORT=$PANEL_PORT" \
  --set "NODE_ENV=production" >/dev/null 2>&1 \
  && c_ok "PORT=$PANEL_PORT · NL_TCP_PORT=$TCP_PORT" \
  || c_warn "متغیرها ست نشدند؛ بعد از دیپلوی از داشبورد ست کن (Variables)."

# ── 5. دیپلوی ───────────────────────────────────────────────────────────────
step "دیپلوی (Dockerfile داخل مخزن)"
railway up --detach
c_ok "دیپلوی شروع شد"

# ── 6. دامنه ────────────────────────────────────────────────────────────────
step "ساخت دامنهٔ HTTPS"
DOMAIN="$(railway domain 2>/dev/null | tail -n 1 | tr -d '[:space:]')" || true
if [ -n "${DOMAIN:-}" ]; then
  case "$DOMAIN" in
    http*) PANEL_URL="$DOMAIN" ;;
    *)     PANEL_URL="https://$DOMAIN" ;;
  esac
  c_ok "آدرس پنل: $PANEL_URL"
else
  PANEL_URL="(از داشبورد ریلوی: Settings → Networking → Generate Domain)"
  c_warn "دامنه خودکار ساخته نشد"
fi

# ── 7. کارهای دستی که API ریلوی انجام نمی‌دهد ───────────────────────────────
cat <<TXT

┌─ سه کار باقی‌مانده (هر کدام یک بار) ─────────────────────────────────────
│  ۱) دامنهٔ HTTPS  →  باید به پورت داخلی  $PANEL_PORT  وصل باشد
│  ۲) TCP Proxy     →  Settings → Networking → TCP Proxy → target $TCP_PORT
│                      (بدون این، REALITY / Shadowsocks / MTProto کار نمی‌کنند)
│  ۳) Volume        →  Mount a volume روی مسیر  /data
│                      (بدون این، کاربران و کلیدها با هر دیپلوی پاک می‌شوند)
└─────────────────────────────────────────────────────────────────────────

آدرس پنل:  ${PANEL_URL}
اولین ورود:  همان آدرس را باز کن → فرم ساخت حساب مدیر می‌آید.

NIGHTLINE · Railway — رایگان و غیرقابل فروش
https://github.com/youdidking/NightLine-Railway
TXT
