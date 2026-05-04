export default function DonatePage() {
  const donationLevels = [
    { amount: '20.000đ', label: 'Ủng hộ cơ bản' },
    { amount: '50.000đ', label: 'Đồng hành cùng dự án' },
    { amount: '100.000đ', label: 'Hỗ trợ phát triển tính năng' },
    { amount: '200.000đ', label: 'Góp sức duy trì hệ thống' },
    { amount: 'Tùy ý', label: 'Đóng góp theo khả năng' },
  ];

  const supportItems = [
    {
      title: 'Duy trì server',
      description:
        'Giúp hệ thống hoạt động ổn định, truy cập mượt mà và phục vụ người dùng liên tục.',
      icon: '🖥️',
    },
    {
      title: 'Chi phí API',
      description:
        'Hỗ trợ các tính năng AI như quiz, flashcard và các trải nghiệm học tập thông minh hơn.',
      icon: '🤖',
    },
    {
      title: 'Lưu trữ tài liệu',
      description:
        'Đảm bảo tài liệu học tập được lưu trữ an toàn và sẵn sàng cho người dùng truy cập.',
      icon: '📚',
    },
  ];

  const paymentMethods = [
    'QR chuyển khoản',
    'Tài khoản ngân hàng',
    'Ví điện tử',
    'Link thanh toán trực tuyến',
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <section className="relative overflow-hidden border-b border-slate-200 bg-white">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-50 via-white to-indigo-50" />
        <div className="relative mx-auto grid max-w-7xl gap-10 px-6 py-20 lg:grid-cols-2 lg:px-10">
          <div className="flex flex-col justify-center">
            <span className="mb-4 inline-flex w-fit rounded-full border border-blue-200 bg-blue-50 px-4 py-1 text-sm font-medium text-blue-700">
              Support EduMate
            </span>
            <h1 className="max-w-2xl text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
              Đồng hành cùng EduMate để xây dựng trải nghiệm học tập tốt hơn.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600">
              Mỗi khoản ủng hộ sẽ giúp chúng tôi duy trì server, chi trả chi phí API, lưu trữ tài liệu
              và tiếp tục phát triển thêm những tính năng hữu ích cho sinh viên và giảng viên.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <a
                href="#donate-levels"
                className="rounded-2xl bg-slate-900 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
              >
                Ủng hộ ngay
              </a>
              <a
                href="#about"
                className="rounded-2xl border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
              >
                Tìm hiểu thêm
              </a>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            {supportItems.map((item) => (
              <div key={item.title} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="text-3xl">{item.icon}</div>
                <h3 className="mt-4 text-lg font-semibold text-slate-900">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{item.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="about" className="mx-auto max-w-7xl px-6 py-16 lg:px-10">
        <div className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">Giới thiệu EduMate</p>
            <h2 className="mt-3 text-3xl font-bold text-slate-900">EduMate là nền tảng hỗ trợ học tập thông minh.</h2>
            <p className="mt-4 text-base leading-8 text-slate-600">
              EduMate được xây dựng để giúp sinh viên và giảng viên tiếp cận tài liệu, ôn tập kiến thức,
              làm quiz, học với flashcard và quản lý việc học thuận tiện hơn. Dự án tập trung vào việc kết
              hợp công nghệ với nhu cầu học tập thực tế để tạo ra một môi trường học tập hiện đại, dễ sử dụng
              và hữu ích.
            </p>
          </div>

          <div className="rounded-3xl bg-slate-900 p-8 text-white shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-200">Vì sao cần donate</p>
            <h2 className="mt-3 text-3xl font-bold">Sự ủng hộ của bạn giúp dự án phát triển bền vững hơn.</h2>
            <ul className="mt-6 space-y-4 text-sm leading-7 text-slate-200">
              <li>• Duy trì server để hệ thống hoạt động ổn định và truy cập mượt mà.</li>
              <li>• Chi trả API phục vụ các tính năng AI như quiz, flashcard và hỗ trợ học tập.</li>
              <li>• Lưu trữ tài liệu học tập an toàn, sẵn sàng cho người dùng sử dụng.</li>
              <li>• Phát triển thêm tính năng mới và cải thiện trải nghiệm học tập lâu dài.</li>
            </ul>
          </div>
        </div>
      </section>

      <section id="donate-levels" className="mx-auto max-w-7xl px-6 py-4 lg:px-10">
        <div className="rounded-[2rem] bg-white p-8 shadow-sm ring-1 ring-slate-200">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">Mức ủng hộ tùy ý</p>
            <h2 className="mt-3 text-3xl font-bold text-slate-900">Bạn có thể ủng hộ với bất kỳ mức nào phù hợp.</h2>
            <p className="mt-4 text-base leading-8 text-slate-600">
              Mỗi khoản đóng góp, dù nhỏ, đều là một động lực để EduMate tiếp tục duy trì hoạt động và phát triển.
              Việc ủng hộ là hoàn toàn tự nguyện.
            </p>
          </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {donationLevels.map((level) => (
              <button
                key={level.amount}
                className="rounded-3xl border border-slate-200 bg-slate-50 p-5 text-left transition hover:border-slate-300 hover:bg-slate-100"
              >
                <div className="text-xl font-bold text-slate-900">{level.amount}</div>
                <div className="mt-2 text-sm text-slate-600">{level.label}</div>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-16 lg:px-10">
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">Cam kết minh bạch</p>
            <h2 className="mt-3 text-3xl font-bold text-slate-900">Chúng tôi sử dụng khoản ủng hộ một cách rõ ràng.</h2>
            <p className="mt-4 text-base leading-8 text-slate-600">
              Toàn bộ khoản đóng góp sẽ được ưu tiên cho các chi phí vận hành và phát triển dự án như server,
              API, lưu trữ tài liệu và cải thiện sản phẩm. Chúng tôi mong muốn EduMate không chỉ hữu ích mà còn
              đáng tin cậy với cộng đồng người dùng.
            </p>
          </div>

          <div className="rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">Phương thức ủng hộ</p>
            <h2 className="mt-3 text-3xl font-bold text-slate-900">Thông tin donate có thể đặt tại đây.</h2>
            <div className="mt-6 grid gap-3">
              {paymentMethods.map((method) => (
                <div key={method} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700">
                  {method}
                </div>
              ))}
            </div>
            <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm leading-7 text-slate-600">
              Thông tin chuyển khoản, mã QR hoặc link thanh toán có thể được cập nhật tại đây khi dự án sẵn sàng triển khai donate chính thức.
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-14 text-center lg:px-10">
          <h2 className="text-3xl font-bold text-slate-900">Cảm ơn bạn đã đồng hành cùng EduMate.</h2>
          <p className="mx-auto mt-4 max-w-3xl text-base leading-8 text-slate-600">
            Sự ủng hộ của bạn không chỉ giúp dự án duy trì hoạt động mà còn góp phần xây dựng một trải nghiệm học tập
            tốt hơn cho nhiều người dùng trong tương lai.
          </p>
        </div>
      </section>
    </div>
  );
}
