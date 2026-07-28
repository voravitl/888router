# Project-Scoped AGENTS.md Rules for 888router

## 🚀 Standard 7-Step End-to-End CI/CD Delivery Pipeline Rule
ทุกครั้งที่มีการพัฒนา แก้ไขโค้ด หรือทำภารกิจในโปรเจกต์นี้ ต้องปฏิบัติตาม **7-Step CI/CD Delivery Pipeline** นี้โดยอัตโนมัติ ห้ามข้ามขั้นตอน:

1. **Step 1: Feature Branch Protection**
   - ห้ามแก้ไข Product Code บน `main` / `master` โดยเด็ดขาด 
   - ต้องตรวจสอบ `git branch` และสวิตช์เป็น `fix/<name>` หรือ `feat/<name>` หรือ `chore/<name>` ก่อนเริ่มแก้ไฟล์เสมอ

2. **Step 2: Automated Verification**
   - รัน Unit Tests (`npx vitest run` / `npm test`) ต้องผ่าน 100%

3. **Step 3: Multi-Model Code Review**
   - รัน `/888router-review` (ส่งให้ Grok, GLM, DeepSeek ตรวจสอบโค้ด) และนำข้อเสนอแนะมาปรับปรุง

4. **Step 4: Production & Docker Build Gate**
   - รัน `npm run build` (Next.js production build)
   - รัน `docker build -t voravitl/888router:v<version> -t voravitl/888router:latest .` ยืนยันว่า Container Image Build ผ่าน

5. **Step 5: Version Bumping, Pull Request & Merge**
   - **Bump Version**: เพิ่มเวอร์ชันใน `package.json` (เช่น `0.10.31` -> `0.10.32`) และเพิ่มบันทึกการเปลี่ยนแปลงใน `CHANGELOG.md` เสมอ
   - **PR & Merge**: Commit, Push ขึ้น Remote, สร้าง Pull Request ด้วย `gh pr create` และ Squash & Merge เข้า `master`

6. **Step 6: Local Container Redeploy & Liveness Check**
   - สวิตช์กลับ `master`, สั่ง `git pull`, รัน `docker compose up -d --force-recreate` เพื่อบังคับ Recreate คอนเทนเนอร์ในเครื่องด้วย Image ใหม่ล่าสุดเสมอ และรัน Health Check (`curl /api/version` และ `/v1/models`) ยืนยันเวอร์ชันใหม่และบริการออนไลน์

7. **Step 7: Durable Knowledge Capture**
   - บันทึกบทเรียนลงวิกิ (`$HOME/wiki/`), อัปเดต `index.md`, และลงบันทึกความรู้ใน LYN
