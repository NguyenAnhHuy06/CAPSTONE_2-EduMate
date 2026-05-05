import { useEffect, useState, type ChangeEvent } from 'react';
import api from '@/services/api';

export default function DonatePage() {
  const [loading, setLoading] = useState(true);
  const [qrVisible, setQrVisible] = useState(true);
  const [donateInfo, setDonateInfo] = useState({
    account_name: '',
    bank_name: '',
    account_number: '',
    qr_image_url: '',
    transfer_note: '',
    message:
      'Mỗi khoản ủng hộ sẽ giúp chúng tôi duy trì server, chi trả chi phí API, lưu trữ tài liệu và tiếp tục phát triển thêm những tính năng hữu ích cho sinh viên và giảng viên.',
    is_enabled: true,
    updated_at: '',
  });

  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [formData, setFormData] = useState({
    account_name: '',
    bank_name: '',
    account_number: '',
    qr_image_url: '',
    transfer_note: '',
    message: '',
    is_enabled: true,
  });

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

    const handleInputChange = (
      e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
    ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleToggleEnabled = (e: ChangeEvent<HTMLInputElement>) => {
    setFormData((prev) => ({
      ...prev,
      is_enabled: e.target.checked,
    }));
  };

  const handleSaveDonateInfo = async () => {
    try {
      setIsSaving(true);
      setSaveMessage('');
      setSaveError('');

      const res = await api.put('/donate/info', formData);
      const payload = res?.data ?? res ?? {};

      const nextData = {
        account_name: payload.account_name || formData.account_name,
        bank_name: payload.bank_name || formData.bank_name,
        account_number: payload.account_number || formData.account_number,
        qr_image_url: payload.qr_image_url || formData.qr_image_url,
        transfer_note: payload.transfer_note || formData.transfer_note,
        message: payload.message || formData.message,
        is_enabled: payload.is_enabled !== false,
        updated_at: payload.updated_at || new Date().toISOString(),
      };

      setQrVisible(!!nextData.qr_image_url);
      setDonateInfo(nextData);
      setSaveMessage('Đã cập nhật thông tin ủng hộ thành công.');
    } catch (err: any) {
      const apiMessage =
        err?.response?.data?.message ||
        err?.message ||
        'Không cập nhật được thông tin ủng hộ.';
      setSaveError(apiMessage);
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    let mounted = true;

    const loadDonateInfo = async () => {
      try {
        setLoading(true);
        const res = await api.get('/donate/info');
        const payload = res?.data ?? res ?? {};

        if (!mounted) return;

        setQrVisible(!!payload.qr_image_url);

        setDonateInfo({
          account_name: payload.account_name || '',
          bank_name: payload.bank_name || '',
          account_number: payload.account_number || '',
          qr_image_url: payload.qr_image_url || '',
          transfer_note: payload.transfer_note || '',
          message:
            payload.message ||
            'Mỗi khoản ủng hộ sẽ giúp chúng tôi duy trì server, chi trả chi phí API, lưu trữ tài liệu và tiếp tục phát triển thêm những tính năng hữu ích cho sinh viên và giảng viên.',
          is_enabled: payload.is_enabled !== false,
          updated_at: payload.updated_at || '',
        });
      } catch (err) {
        console.error('Failed to load donate info:', err);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    loadDonateInfo();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    try {
      const rawUser = localStorage.getItem('edumate_user');
      if (!rawUser) return;

      const user = JSON.parse(rawUser);
      const role = String(user?.role || '').toUpperCase();
      setIsAdmin(role === 'ADMIN');
    } catch {
      setIsAdmin(false);
    }
  }, []);

  useEffect(() => {
    setFormData({
      account_name: donateInfo.account_name || '',
      bank_name: donateInfo.bank_name || '',
      account_number: donateInfo.account_number || '',
      qr_image_url: donateInfo.qr_image_url || '',
      transfer_note: donateInfo.transfer_note || '',
      message: donateInfo.message || '',
      is_enabled: donateInfo.is_enabled !== false,
    });
  }, [donateInfo]);
  

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      {!donateInfo.is_enabled && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-3 text-sm text-amber-800 text-center">
          Tính năng ủng hộ hiện đang tạm tắt.
        </div>
      )}

      {loading && (
        <div className="bg-blue-50 border-b border-blue-200 px-6 py-3 text-sm text-blue-800 text-center">
          Đang tải thông tin ủng hộ...
        </div>
      )}

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
              {donateInfo.message}
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
            <h2 className="mt-3 text-3xl font-bold text-slate-900">Thông tin ủng hộ hiện tại.</h2>

            <div className="mt-6 grid gap-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700">
                <span className="block text-slate-500 text-xs mb-1">Tên tài khoản</span>
                {donateInfo.account_name || 'Chưa cập nhật'}
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700">
                <span className="block text-slate-500 text-xs mb-1">Ngân hàng</span>
                {donateInfo.bank_name || 'Chưa cập nhật'}
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700">
                <span className="block text-slate-500 text-xs mb-1">Số tài khoản</span>
                {donateInfo.account_number || 'Chưa cập nhật'}
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700">
                <span className="block text-slate-500 text-xs mb-1">Nội dung chuyển khoản</span>
                {donateInfo.transfer_note || 'Chưa cập nhật'}
              </div>
            </div>

            {donateInfo.qr_image_url && qrVisible ? (
              <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-700 mb-3">Mã QR ủng hộ</p>
                <img
                  src={donateInfo.qr_image_url}
                  alt="QR donate"
                  className="mx-auto max-h-72 rounded-xl border border-slate-200 bg-white p-2"
                  onError={() => setQrVisible(false)}
                />
              </div>
            ) : null}

            {donateInfo.updated_at ? (
              <p className="mt-4 text-xs text-slate-500">
                Cập nhật lần cuối: {new Date(donateInfo.updated_at).toLocaleString('vi-VN')}
              </p>
            ) : null}

            <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm leading-7 text-slate-600">
              Nếu bạn muốn đồng hành cùng EduMate, có thể ủng hộ qua thông tin bên trên. Sự đóng góp của bạn sẽ giúp dự án duy trì server, chi trả chi phí API, lưu trữ tài liệu và tiếp tục phát triển thêm tính năng mới.
            </div>
          </div>
        </div>
      </section>

      {isAdmin && (
        <section className="mx-auto max-w-7xl px-6 pb-16 lg:px-10">
          <div className="rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">
              Quản trị Donate
            </p>
            <h2 className="mt-3 text-3xl font-bold text-slate-900">
              Cập nhật thông tin ủng hộ
            </h2>
            <p className="mt-4 text-base leading-8 text-slate-600">
              Khu vực này chỉ dành cho admin để chỉnh sửa nội dung hiển thị trên trang Donate.
            </p>

            <div className="mt-8 grid gap-6 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">
                  Tên tài khoản
                </label>
                <input
                  name="account_name"
                  value={formData.account_name}
                  onChange={handleInputChange}
                  className="w-full rounded-2xl border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">
                  Ngân hàng
                </label>
                <input
                  name="bank_name"
                  value={formData.bank_name}
                  onChange={handleInputChange}
                  className="w-full rounded-2xl border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">
                  Số tài khoản
                </label>
                <input
                  name="account_number"
                  value={formData.account_number}
                  onChange={handleInputChange}
                  className="w-full rounded-2xl border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">
                  Nội dung chuyển khoản
                </label>
                <input
                  name="transfer_note"
                  value={formData.transfer_note}
                  onChange={handleInputChange}
                  className="w-full rounded-2xl border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
                />
              </div>

              <div className="md:col-span-2">
                <label className="mb-2 block text-sm font-medium text-slate-700">
                  QR image URL
                </label>
                <input
                  name="qr_image_url"
                  value={formData.qr_image_url}
                  onChange={handleInputChange}
                  className="w-full rounded-2xl border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
                />
              </div>

              <div className="md:col-span-2">
                <label className="mb-2 block text-sm font-medium text-slate-700">
                  Thông điệp hiển thị
                </label>
                <textarea
                  name="message"
                  value={formData.message}
                  onChange={handleInputChange}
                  rows={4}
                  className="w-full rounded-2xl border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
                />
              </div>

              <div className="md:col-span-2">
                <label className="inline-flex items-center gap-3 text-sm font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={formData.is_enabled}
                    onChange={handleToggleEnabled}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Bật tính năng donate
                </label>
              </div>
            </div>

            {saveMessage && (
              <div className="mt-6 rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
                {saveMessage}
              </div>
            )}

            {saveError && (
              <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {saveError}
              </div>
            )}

            <div className="mt-8">
              <button
                type="button"
                onClick={handleSaveDonateInfo}
                disabled={isSaving}
                className="rounded-2xl bg-slate-900 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSaving ? 'Đang lưu...' : 'Lưu thông tin donate'}
              </button>
            </div>
          </div>
        </section>
      )}

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