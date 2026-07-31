# Project-Scoped AGENTS.md Rules for 888router

## 🚀 Standard 7-Step End-to-End CI/CD Delivery Pipeline Rule (SSOT)
ทุกครั้งที่มีการพัฒนา แก้ไขโค้ด หรือทำภารกิจในโปรเจกต์นี้ ต้องปฏิบัติตาม **7-Step CI/CD Delivery Pipeline** นี้โดยอัตโนมัติ ห้ามข้ามขั้นตอนเด็ดขาด:

### 🔴 PHASE 1: BEFORE MERGE (ทำบน Feature Branch)
1. **Step 1: Feature Branch Protection**
   - ห้ามแก้ไข Product Code บน `main` / `master` โดยเด็ดขาด 
   - ต้องตรวจสอบ `git branch` และสวิตช์เป็น `fix/<name>` หรือ `feat/<name>` หรือ `chore/<name>` ก่อนเริ่มแก้ไฟล์เสมอ

2. **Step 2: Automated Verification**
   - รัน Unit Tests (`npx vitest run --config tests/vitest.config.js`) ต้องผ่าน 100% ทั้งหมดก่อนดำเนินการต่อ

3. **Step 3: Multi-Model Code Review (BEFORE MERGE GATE)**
   - **ห้าม Merge ลง master เด็ดขาดก่อนผ่าน Step 3!**
   - ส่ง Code Diff ให้ AI ทบทวนผ่าน `/ollama-delegate` (`ollama-cc -p "Review diff: $(git diff HEAD~1..HEAD)"`) หรือ `/grok-delegate` (`grok prompt`)
   - แก้ไขข้อผิดพลาด (Critical / High Findings) ให้เรียบร้อยและรัน Re-test จนผ่าน 100%

---

### 🟢 PHASE 2: AFTER MERGE (ทำเมื่อ Merge ลง master และรัน `./scripts/cicd-release.sh <version>`)
4. **Step 4: Production & Docker Build Gate**
   - รัน `npm run build` (Next.js production build) ยืนยันว่าไม่มี Build Error
   - รัน `docker build -t voravitl/888router:v<version> -t voravitl/888router:latest .` ยืนยันว่า Container Image Build ผ่าน

5. **Step 5: Version Bumping, Release Tagging, Registry Push & Merge**
   - **Bump Version**: เพิ่มเวอร์ชันใน `package.json` (เช่น `0.11.0` -> `0.11.1`) และบันทึกใน `CHANGELOG.md`
   - **Merge**: Merge branch เข้า `master` และ push ขึ้น `origin/master`
   - **Git Tagging**: สร้างและ push release tag: `git tag -a v<version> -m "Release v<version>"` && `git push origin v<version>`
   - **Docker Registry Push**: Push ขึ้น Docker Hub Registry: `docker push voravitl/888router:v<version>` && `docker push voravitl/888router:latest`

6. **Step 6: Local Container Redeploy & Liveness Check**
   - รัน `docker compose up -d --force-recreate` เพื่อบังคับ Recreate คอนเทนเนอร์ในเครื่องด้วย Image ใหม่ล่าสุดเสมอ
   - รัน Health Check (`curl http://localhost:20128/api/version`) ยืนยันว่า `currentVersion` ตรงกับเวอร์ชันใหม่และบริการออนไลน์

7. **Step 7: Durable Knowledge Capture**
   - บันทึกบทเรียนลงวิกิ (`$HOME/wiki/<topic-date>.md`), อัปเดต `index.md`, และลงบันทึกความรู้ใน LYN
