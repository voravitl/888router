# Project-Scoped AGENTS.md Rules for 888router

> **See the repo-root [`../AGENTS.md`](../AGENTS.md) for the canonical tool-agnostic delivery
> rules and operational lessons** (e.g. the Docker `su-exec`/`setgroups` vs. hardened k8s
> `securityContext` regression, v0.15.99 → v0.15.100, and "a fix isn't shipped until the
> version + every k8s image tag move together"). Incident write-ups: `.agents/incidents/`.
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
4. **Step 4: Production & Docker Build Gate (ทำก่อนแตะ K8s เสมอ!)**
   - รัน `npm run build` (Next.js production build) ยืนยันว่าไม่มี Build Error
   - **MANDATORY: Build Docker Image เข้า Local OrbStack Daemon ก่อนเสมอ**:
     `docker build -t voravitl/888router:<version> -t voravitl/888router:latest .`
     *(🚨 กฎเหล็ก: Tag ของ Image ใน K8s ต้องเป็นตัวเลขล้วน **ไม่มี `v`** เช่น `0.15.120` ห้ามใส่ `v0.15.120` เด็ดขาด)*
     *(💡 ทำไมต้อง build ก่อน: Deployment ใช้ `strategy: Recreate` หาก apply ก่อนมี image ในเครื่อง K8s จะไป pull จาก Docker Hub ซึ่งยัง build ไม่เสร็จ ทำให้เกิด `ImagePullBackOff` และเว็บดับ 503 ทันที)*

5. **Step 5: Version Bumping, Release Tagging, Push & Merge**
   - **Bump Version 4 จุด**:
     - `package.json` + `package-lock.json` (`npm install --package-lock-only`)
     - `k8s/base/888router.yaml` (image tag)
     - `k8s/overlays/local/kustomization.yaml` (`images[].newTag`)
     - `k8s/overlays/prd/kustomization.yaml` (`images[].newTag`)
     - บันทึกใน `CHANGELOG.md`
   - **Merge & Push**: Merge branch เข้า `master` และ `git push origin master`
   - **Git Tagging (มี `v`)**: สร้างและ push release tag: `git tag -a v<version> -m "Release v<version>"` && `git push origin v<version>`
   - *(GitHub Actions จะทำการ build & push Image ขึ้น Docker Hub ใน cloud ให้โดยอัตโนมัติ)*

6. **Step 6: Local Kubernetes Redeploy & Liveness Check**
   - **ห้ามใช้ `docker compose up` เด็ดขาด**: Production รันอยู่บน **Kubernetes (OrbStack) namespace `888router`**
   - รัน Deploy Kustomize:
     `kubectl apply -k k8s/overlays/local`
   - รอ Rollout ให้ Pod ใหม่ Ready:
     `kubectl rollout status deploy/888router -n 888router --timeout=120s`
   - ตรวจสอบ Liveness Endpoint จริง:
     `curl -s http://router.k8s.orb.local/api/version`
     *(ต้องได้ HTTP 200 และ `currentVersion` ตรงกับเวอร์ชันใหม่)*
   - **Emergency Rollback (หากเกิดเหตุเว็บ 503 หรือ Pod ไม่ Ready)**:
     `kubectl rollout undo deploy/888router -n 888router`

7. **Step 7: Durable Knowledge Capture**
   - บันทึกบทเรียนลงวิกิ (`$HOME/wiki/...`), อัปเดต `index.md`, และรัน 12-Gate Audit Check (100% Green)
