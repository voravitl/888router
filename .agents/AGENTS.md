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

3. **Step 3: Self-Review by the Writing Agent (BEFORE MERGE GATE)**
   - **ห้าม Merge ลง master เด็ดขาดก่อนผ่าน Step 3!**
   - **เปลี่ยนกฎ 2026-10-21: ให้ agent ที่เขียนโค้ดเองเป็นผู้ review diff ของตัวเอง ไม่ต้องส่งให้โมเดล/CLI/service อื่นตรวจ** (เลิกใช้ ladder ของ reviewer อิสระแล้ว)
   - วิธี review เองที่บังคับ:
     - อ่าน diff ใหม่ในฐานะ "คนที่ไม่เคยเห็นไฟล์เดิม" — ทุก hunk ถามว่ามันพังอะไร และ input แบบไหนทำให้มันผิด
     - อ่าน **ไฟล์เต็ม** ของทุกไฟล์ที่แตะ ไม่ใช่แค่ hunk (อ่านแค่ diff คือต้นเหตุ false positive/negative ที่พบบ่อยที่สุด)
     - **เขียนเทสต์ที่ fail ก่อน แล้วค่อยแก้** — เทสต์ต้อง fail บน base commit และ pass บน branch ถ้าเขียนเทสต์ที่ fail ไม่ได้ แปลว่ายังไม่เข้าใจบั๊ก
     - พิสูจน์กับของจริง ไม่ใช่ตัวแทน — รัน path จริง อ่านค่าจริง ("คอมไพล์ผ่าน" กับ "CI เขียว" ไม่ใช่หลักฐาน)
     - ไล่ boundary case เอง: null/ฟิลด์หาย/สตริงว่าง/อาร์เรย์ 1 ตัว/alias ซ้ำ/ขอบใหม่ท้าย stream/ค่าที่มาถึงตอนจบ stream พอดี
     - เช็คว่าของเดิมที่เคยใช้ได้ยังใช้ได้ — รันเทสต์เต็ม `npx vitest run --config tests/vitest.config.js` (จาก repo root) ไม่ใช่แค่เทสต์ใหม่
     - เช็คว่า claim ใน CHANGELOG ตรงกับ diff และไม่กว้างเกินจริง
     - อ่าน diff สุดท้ายอีกครั้งหลังแก้ครั้งสุดท้าย (bump + snapshot + fix ต้องอยู่ PR เดียวกัน)
   - เกณฑ์ severity: แก้ทุก CRITICAL/HIGH ก่อน merge; MEDIUM/LOW แก้ถ้าทำได้เล็กและปลอดภัย ถ้าไม่แก้ให้บันทึกไว้เป็น follow-up (ใน changelog หรือ PR description) ห้ามทิ้งเงียบ ๆ
   - ถ้าเจอปัญหาที่แก้ไม่ได้ ให้รายงาน — ห้าม merge diff ที่ตัวเองรู้ว่าพัง

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
   - บทเรียนจาก bug ล่าสุด (2026-10-21, v0.15.178 → v0.15.179): **client format อาจถูก adapt นอกชั้น translator** — Gemini client format (`/v1beta/models/...`) ไม่มี response translator `openai → gemini` ที่ลงทะเบียนไว้ ตัวแปลงจริงอยู่ที่ route handler `src/app/api/v1beta/models/[...path]/route.js` ซึ่งอ่านแค่ `content` เท่านั้น ทำให้ refusal-only answer หายไป ก่อนสรุปว่า "format นี้รองรับแล้ว" ต้อง grep หา shape ที่ตัวเอง emit (`candidates:`, `parts:`, `text_delta`, `output_text`) แล้วทดสอบ adapter ตัวที่รันจริง — ดูรายละเอียดใน `../AGENTS.md`
