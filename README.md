# EduMate

**EduMate** is a smart learning support and academic document sharing system built for students, lecturers, and administrators in the DTU/CMU environment. The project centralizes official learning materials, supports intelligent search, and integrates academic AI Q&A with source citations to improve learning outcomes and reduce repetitive support work.

---

## 1. Project overview

In university settings, students often struggle to find academic information or course materials because data is scattered, hard to search, and not centralized. Meanwhile, popular AI tools can answer quickly but do not guarantee accuracy against official school materials.

EduMate addresses this by combining:
- a centralized academic document repository,
- smart document search,
- academic AI Q&A grounded in official materials,
- and automatic quiz/flashcard generation for review.

---

## 2. Project goals

- Centralize learning materials and CMU academic documents on one platform.
- Help students find documents quickly by course code, keywords, semester, or document type.
- Provide AI answers tightly grounded in verified materials.
- Show source citations so users can verify responses.
- Generate quizzes and flashcards from course materials to support review.
- Reduce repetitive support load for lecturers and academic staff.

---

## 3. Main features

### Document management
- Upload and download academic documents (PDF/DOCX)
- Organize documents by course, semester, and type
- Browse and search by course code or course name
- Lecturer verification workflow for uploaded documents
- Document version history and basic reporting

### AI-powered learning support
- Academic Q&A using Retrieval-Augmented Generation (RAG)
- Specific source citations for AI answers
- Automatic quiz generation from course materials
- Automatic flashcard generation for review
- Document viewer that can highlight AI-referenced content

### Learning progress
- Quiz history and quiz lists
- Quiz editing (for lecturers)
- Leaderboard
- Learning progress tracking

### System administration
- Role and permission management
- DTU email access control
- Important activity logs
- Document library management

---

## 4. Users

- **Students**: find materials, ask AI, create quizzes/flashcards, and track learning progress.
- **Lecturers / Academic staff**: upload, verify, and manage official materials; review AI-generated quizzes.
- **Administrators**: manage users, permissions, the document library, and moderation workflows.

---

## 5. Technology stack

- **Frontend**: ReactJS, HTML, CSS, JavaScript
- **Backend**: Node.js, Python (FastAPI / AI processing)
- **Database**: MySQL
- **File storage**: AWS S3
- **Semantic retrieval layer**: embedding vector DB (Chroma / FAISS / Qdrant depending on deployment)
- **AI integration**: external LLM API with RAG pipeline
- **Tools**: GitHub, Postman, Figma, Discord, Zalo

---

## 6. High-level architecture

EduMate is designed as a web system with:
- **ReactJS frontend** for student, lecturer, and admin UIs,
- **Node.js web core** for auth, document management, and quiz/history,
- **Python AI engine** for document chunking, semantic retrieval, and AI content generation,
- **MySQL** for relational data,
- **AWS S3** for document storage,
- and a **vector database** for semantic search.

This architecture lets the system answer academic questions with AI while staying aligned with trustworthy school materials.

---

## 7. Project scope

### In scope
- CMU document management
- Smart search and document view/download
- Academic AI Q&A with source citations
- Quiz and flashcard generation
- Basic administration and access control

### Out of scope
- Advanced personalization and recommendation systems
- Deep LMS/SSO integration
- Multimedia search (video/audio)
- Advanced OCR for fully scanned documents

---

## 8. Development approach

The project uses **Scrum** with multiple development sprints, incremental releases, continuous feedback, and an MVP-first mindset.

Main phases:
- Initiation and documentation
- Sprint 1: auth, dashboard, upload/search documents, verification, AI quiz/flashcard
- Sprint 2: quiz history, AI chat, source citation, document viewer, admin data management
- Sprint 3: roles/permissions, audit logs, moderation flow, document version history

---

## 9. Team members

| # | Student ID | Full name | Email |
|---|---|---|---|
| 1 | 28209043094 | Ngo Thi Tuyet Nhung | nn8242115@gmail.com |
| 2 | 28210205517 | Nguyen Anh Huy | anhhuynguyenqn23@gmail.com |
| 3 | 28210203983 | Ho Ngoc Dang Khanh | hndangkhanh0207@gmail.com |
| 4 | 28211100259 | Tran Quoc Khang | Tranquockhang1@dtu.edu.vn |
| 5 | 28219032487 | Luong Minh Tam | dichtanthanh@gmail.com |

---

## 10. Project documents

Supported project artifacts include:
- Project Proposal
- Project Plan
- Product Backlog
- User Stories
- Architecture Design Document
- Database Design Document

---

## 11. EduMate highlights

Compared with general AI tools or static file storage platforms, EduMate focuses on **academic trustworthiness**:
- Answers are generated from official materials.
- Source citations help users verify information.
- Lecturers can verify materials added to the system.
- AI supports learning; it does not replace official academic evidence.

---

## 12. Future direction

- Better OCR for scanned documents
- Personalized learning recommendations
- Suggested learning paths
- Deeper learning analytics
- Broader integration with university platforms

---

## 13. Contact

For project information, collaboration, or academic discussion, please contact team members listed above.

---

## 14. Run locally

**Backend (production API, default port 5000):**

```bash
cp .env.example .env
# Edit .env (MySQL, JWT, S3, OpenAI, …)
npm install
npm run dev
```

**Frontend (Vite, port 5173):**

```bash
cd FE/edumate-fe
cp .env.example .env
npm install
npm run dev
```

Set `VITE_PROXY_TARGET=http://127.0.0.1:5000` in `FE/edumate-fe/.env` so `/api` proxies to the backend.

**Optional mock API** (`FE/server.js`, port 3001): `npm run dev:api` from the repo root.
