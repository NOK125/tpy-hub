#!/bin/sh
# ติดตั้งหรืออัปเดต TPY HR บนเซิร์ฟเวอร์ Ubuntu (รันด้วย root)
# โค้ดอยู่ที่ /opt/tpy-hub ข้อมูลจริงอยู่ที่ /var/lib/tpy-hub (ไม่ถูกเขียนทับตอนอัปเดต)
set -e
REPO="${1:-https://github.com/NOK125/tpy-hub.git}"
id tpyhub >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin tpyhub
mkdir -p /var/lib/tpy-hub/files
chown -R tpyhub:tpyhub /var/lib/tpy-hub
chmod 750 /var/lib/tpy-hub
if [ -d /opt/tpy-hub/.git ]; then
  git -C /opt/tpy-hub pull --ff-only
else
  git clone "$REPO" /opt/tpy-hub
fi
cp /opt/tpy-hub/deploy/tpy-hub.service /etc/systemd/system/tpy-hub.service
systemctl daemon-reload
systemctl enable tpy-hub
systemctl restart tpy-hub
sleep 2
systemctl --no-pager status tpy-hub | head -5
curl -s http://127.0.0.1:8100/api/setup && echo && echo "TPY HR พร้อมใช้งานที่พอร์ต 8100"
