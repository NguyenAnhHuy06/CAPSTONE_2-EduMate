# EduMate

**EduMate** là hệ thống hỗ trợ học tập thông minh và chia sẻ tài liệu học thuật, được xây dựng cho sinh viên, giảng viên và quản trị viên trong môi trường DTU/CMU. Dự án giúp tập trung hóa tài liệu học tập chính thống, hỗ trợ tìm kiếm thông minh, đồng thời tích hợp AI hỏi đáp học thuật kèm trích dẫn nguồn để nâng cao hiệu quả học tập và giảm tải việc hỗ trợ lặp lại.

---

## 1. Tổng quan dự án

Trong môi trường đại học, sinh viên thường gặp khó khăn khi tìm kiếm thông tin học thuật hoặc tài liệu môn học vì dữ liệu bị phân tán, khó tra cứu và thiếu tính tập trung. Bên cạnh đó, các công cụ AI phổ biến có thể trả lời nhanh nhưng chưa bảo đảm độ chính xác theo tài liệu chính thức của nhà trường.

EduMate được xây dựng để giải quyết bài toán đó bằng cách kết hợp:
- kho tài liệu học thuật tập trung,
- công cụ tìm kiếm tài liệu thông minh,
- AI hỏi đáp học thuật dựa trên tài liệu chính thức,
- và tính năng tạo quiz/flashcard tự động để hỗ trợ ôn tập.

---

## 2. Mục tiêu dự án

- Tập trung tài liệu học tập và tài liệu học thuật CMU trên cùng một nền tảng.
- Giúp sinh viên tìm tài liệu nhanh theo mã môn, từ khóa, học kỳ hoặc loại tài liệu.
- Cung cấp câu trả lời AI dựa chặt chẽ trên tài liệu đã xác minh.
- Hiển thị trích dẫn nguồn để người dùng có thể kiểm chứng câu trả lời.
- Sinh quiz và flashcard từ tài liệu môn học để hỗ trợ ôn tập.
- Giảm khối lượng hỗ trợ lặp lại cho giảng viên và nhân sự học vụ.

---

## 3. Tính năng chính

### Quản lý tài liệu
- Tải lên và tải xuống tài liệu học thuật (PDF/DOCX)
- Tổ chức tài liệu theo môn học, học kỳ và loại tài liệu
- Xem danh sách tài liệu và tìm kiếm theo mã môn hoặc tên môn
- Quy trình giảng viên xác minh tài liệu đã tải lên
- Theo dõi lịch sử phiên bản tài liệu và xử lý báo cáo cơ bản

### Hỗ trợ học tập bằng AI
- Hỏi đáp học thuật bằng cơ chế Retrieval-Augmented Generation (RAG)
- Trích dẫn nguồn cụ thể cho câu trả lời AI
- Tạo quiz tự động từ tài liệu môn học
- Tạo flashcard tự động phục vụ ôn tập
- Trình xem tài liệu có thể làm nổi bật nội dung được AI tham chiếu

### Theo dõi học tập
- Lịch sử quiz và danh sách quiz
- Chỉnh sửa quiz (dành cho giảng viên)
- Bảng xếp hạng
- Theo dõi tiến độ học tập

### Quản trị hệ thống
- Quản lý vai trò và phân quyền
- Kiểm soát truy cập bằng email DTU
- Nhật ký hoạt động quan trọng
- Quản lý thư viện tài liệu

---

## 4. Đối tượng sử dụng

- **Sinh viên**: tìm tài liệu, hỏi AI, tạo quiz/flashcard và theo dõi tiến độ học tập.
- **Giảng viên / Nhân sự học vụ**: tải lên, xác minh và quản lý tài liệu chính thức; rà soát quiz do AI tạo.
- **Quản trị viên**: quản lý người dùng, phân quyền, thư viện tài liệu và quy trình kiểm duyệt.

---

## 5. Công nghệ sử dụng

- **Frontend**: ReactJS, HTML, CSS, JavaScript
- **Backend**: Node.js, Python (FastAPI / AI processing)
- **Database**: MySQL
- **Lưu trữ tệp**: AWS S3
- **Lớp truy hồi ngữ nghĩa**: Vector DB nhúng (Chroma / FAISS / Qdrant tùy môi trường triển khai)
- **AI Integration**: External LLM API kết hợp RAG pipeline
- **Công cụ hỗ trợ**: GitHub, Postman, Figma, Discord, Zalo

---

## 6. Kiến trúc tổng quan

EduMate được thiết kế như một hệ thống web gồm:
- **Frontend ReactJS** cho giao diện sinh viên, giảng viên và quản trị viên,
- **Node.js Web Core** xử lý xác thực, quản lý tài liệu và lịch sử/quiz,
- **Python AI Engine** xử lý tách tài liệu, truy hồi ngữ nghĩa và sinh nội dung AI,
- **MySQL** lưu dữ liệu quan hệ,
- **AWS S3** lưu tài liệu,
- và **Vector Database** phục vụ tìm kiếm ngữ nghĩa.

Kiến trúc này giúp hệ thống trả lời câu hỏi học thuật bằng AI nhưng vẫn bám sát tài liệu đáng tin cậy của trường.

---

## 7. Phạm vi dự án

### Trong phạm vi
- Quản lý tài liệu CMU
- Tìm kiếm thông minh và xem/tải tài liệu
- Hỏi đáp học thuật bằng AI kèm trích dẫn nguồn
- Tạo quiz và flashcard
- Quản trị cơ bản và kiểm soát truy cập

### Ngoài phạm vi
- Cá nhân hóa nâng cao và hệ gợi ý
- Tích hợp sâu với LMS/SSO
- Tìm kiếm đa phương tiện (video/audio)
- OCR nâng cao cho tài liệu scan hoàn toàn

---

## 8. Phương pháp phát triển

Dự án áp dụng **Scrum** với nhiều sprint phát triển, tập trung vào phát hành theo từng giai đoạn, nhận phản hồi liên tục và ưu tiên MVP.

Các giai đoạn chính:
- Giai đoạn khởi tạo và lập tài liệu
- Sprint 1: xác thực, dashboard, upload/search tài liệu, xác minh, AI quiz/flashcard
- Sprint 2: quiz history, AI chat, source citation, document viewer, admin data management
- Sprint 3: roles/permissions, audit logs, moderation flow, document version history

---

## 9. Thành viên nhóm

| STT | MSSV | Họ và tên | Email |
|---|---|---|---|
| 1 | 28209043094 | Ngo Thi Tuyet Nhung | nn8242115@gmail.com |
| 2 | 28210205517 | Nguyen Anh Huy | anhhuynguyenqn23@gmail.com |
| 3 | 28210203983 | Ho Ngoc Dang Khanh | hndangkhanh0207@gmail.com |
| 4 | 28211100259 | Tran Quoc Khang | Tranquockhang1@dtu.edu.vn |
| 5 | 28219032487 | Luong Minh Tam | dichtanthanh@gmail.com |

---

## 10. Tài liệu dự án

Dự án được hỗ trợ bởi các tài liệu sau:
- Project Proposal
- Project Plan
- Product Backlog
- User Stories
- Architecture Design Document
- Database Design Document

---

## 11. Điểm nổi bật của EduMate

So với các công cụ AI tổng quát hoặc nền tảng lưu trữ tệp tĩnh, EduMate tập trung vào **độ tin cậy học thuật**:
- Câu trả lời được tạo dựa trên tài liệu chính thức.
- Trích dẫn nguồn giúp người dùng kiểm chứng thông tin.
- Giảng viên có thể xác minh tài liệu được đưa vào hệ thống.
- AI đóng vai trò hỗ trợ học tập, không thay thế bằng chứng học thuật chính thống.

---

## 12. Hướng phát triển tương lai

- Cải thiện OCR cho tài liệu scan
- Gợi ý học tập cá nhân hóa
- Đề xuất lộ trình học tập
- Phân tích học tập chuyên sâu hơn
- Tích hợp rộng hơn với các nền tảng của trường

---

## 13. Liên hệ

Mọi thông tin liên quan đến dự án, hợp tác hoặc trao đổi học thuật, vui lòng liên hệ các thành viên trong nhóm ở phần trên.
