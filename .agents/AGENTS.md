# Project-Scoped AGENTS.md Rules for 888router

> **See the repo-root [`../AGENTS.md`](../AGENTS.md) for the canonical tool-agnostic delivery
> rules and operational lessons** (e.g. the Docker `su-exec`/`setgroups` vs. hardened
> `securityContext` regression, v0.15.99 → v0.15.100, and "a fix isn't shipped until the
> version moves and the live container reports it"). Incident write-ups: `.agents/incidents/`.
> This file adds the project-scoped CI/CD pipeline detail on top of those shared rules.

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
   - ส่ง Code Diff ให้ AI ทบทวนผ่าน `9-opus` via 888router (`python3 ~/.hermes/scripts/888router-review.py --model 9-opus --file /tmp/pr.diff`) เป็นหลัก (เนื่องจาก Grok quota หมด), `/ollama-delegate`, หรือ 888router-review
   - แก้ไขข้อผิดพลาด (Critical / High Findings) ให้เรียบร้อยและรัน Re-test จนผ่าน 100%

---

### 🟢 PHASE 2: AFTER MERGE (ทำเมื่อ Merge ลง master)
4. **Step 4: Production & Docker Build Gate**
   - รัน `npm run build` (Next.js production build) ยืนยันว่าไม่มี Build Error
   - *(ยกเลิกการ build image เข้า local daemon แล้ว 2026-09-30 — deploy เป็น docker compose, image มาจาก Docker Hub โดย CI publish)*

5. **Step 5: Version Bumping, Release Tagging, Push & Merge**
   - **Bump Version 2 จุด**:
     - `package.json` + `package-lock.json` (`npm install --package-lock-only`)
     - บันทึกใน `CHANGELOG.md`
     - *(k8s image tag ไม่ต้อง bump อีกต่อไป — k8s ไม่ถูก deploy แล้ว, issue #501)*
   - **Merge & Push**: Merge branch เข้า `master` และ `git push origin master`
   - **Git Tagging (มี `v`)**: สร้างและ push release tag: `git tag -a v<version> -m "Release v<version>"` && `git push origin v<version>`
   - *(GitHub Actions จะทำการ build & push Image ขึ้น Docker Hub ใน cloud ให้โดยอัตโนมัติ)*

6. **Step 6: Docker Compose Redeploy & Liveness Check**
   - **ห้ามใช้ `kubectl apply` เด็ดขาด**: k8s ถูกถอดออกจาก deploy path แล้ว (issue #501) — `k8s/` เหลือแค่เป็น reference
   - ปกติ: รอ CI publish เสร็จ แล้ว watchtower จะ pull `:latest` ให้ `888route` (พอร์ต 20129 — ตัวที่รันจริง) เอง
   - ถ้าอยากอัปเดตทันที (ไม่ต้องรอ watchtower):
     `docker compose pull 888route && docker compose up -d 888route`
   - ตรวจสอบ Liveness Endpoint จริง:
     `curl -s http://localhost:20129/api/version`
     *(ต้องได้ HTTP 200 และ `currentVersion` ตรงกับเวอร์ชันใหม่)*
   - **Emergency Rollback (หากเว็บ 503 หรือ container ไม่ Ready)**:
     เปลี่ยน `888route.image` กลับไปเป็น release ก่อนหน้า แล้ว `docker compose up -d 888route`

7. **Step 7: Durable Knowledge Capture**
   - บันทึกบทเรียนลงวิกิ (`$HOME/wiki/...`), อัปเดต `index.md`, และรัน 12-Gate Audit Check (100% Green)
