import { useEffect, useState, type ChangeEvent } from 'react';
import api, { getApiErrorMessage } from '@/services/api';

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
      'Every contribution helps us maintain servers, pay API costs, store learning materials, and keep building useful features for students and lecturers.',
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
    { amount: '20,000 VND', label: 'Basic support' },
    { amount: '50,000 VND', label: 'Project partner' },
    { amount: '100,000 VND', label: 'Feature development' },
    { amount: '200,000 VND', label: 'System upkeep' },
    { amount: 'Custom', label: 'Give what you can' },
  ];

  const supportItems = [
    {
      title: 'Server upkeep',
      description:
        'Keeps the platform stable, fast, and available for everyone.',
      icon: '🖥️',
    },
    {
      title: 'API costs',
      description:
        'Powers AI features such as quizzes, flashcards, and smarter study experiences.',
      icon: '🤖',
    },
    {
      title: 'Document storage',
      description:
        'Keeps course materials stored safely and ready for users to access.',
      icon: '📚',
    },
  ];

  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [donationForm, setDonationForm] = useState({
    amount: '',
    transfer_note: '',
    transaction_code: '',
    message: '',
  });

  const [donationSubmitting, setDonationSubmitting] = useState(false);
  const [donationMessage, setDonationMessage] = useState('');
  const [donationError, setDonationError] = useState('');
  const [myDonations, setMyDonations] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

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

      const res: any = await api.put('/donate/info', formData);
      const payload = res?.data ?? res ?? {};
      const data = payload?.data ?? payload;

      const nextData = {
        account_name: data.account_name || formData.account_name,
        bank_name: data.bank_name || formData.bank_name,
        account_number: data.account_number || formData.account_number,
        qr_image_url: data.qr_image_url || formData.qr_image_url,
        transfer_note: data.transfer_note || formData.transfer_note,
        message: data.message || formData.message,
        is_enabled: data.is_enabled !== false,
        updated_at: data.updated_at || new Date().toISOString(),
      };

      setQrVisible(!!nextData.qr_image_url);
      setDonateInfo(nextData);
      setSaveMessage('Donation information updated successfully.');
    } catch (err: any) {
      const apiMessage =
        err?.response?.data?.message ||
        err?.message ||
        'Could not update donation information.';
      setSaveError(apiMessage);
    } finally {
      setIsSaving(false);
    }
  };

  const loadMyDonations = async () => {
    try {
      const token = localStorage.getItem('edumate_token');
      if (!token) return;

      setHistoryLoading(true);
      const res: any = await api.get('/donations/my');
      const payload = res?.data ?? res ?? {};
      setMyDonations(Array.isArray(payload) ? payload : payload.data || []);
    } catch (err) {
      console.error('Failed to load donation history:', err);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleDonationFormChange = (
    e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setDonationForm((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleReceiptChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setDonationError('');

    if (!file) {
      setReceiptFile(null);
      return;
    }

    const allowedTypes = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
    ];

    if (!allowedTypes.includes(file.type)) {
      setReceiptFile(null);
      e.target.value = '';
      setDonationError('Receipt must be JPG, PNG, WEBP, or PDF.');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setReceiptFile(null);
      e.target.value = '';
      setDonationError('Receipt must not exceed 10MB.');
      return;
    }

    setReceiptFile(file);
  };

  const handleSelectDonationLevel = (amount: string) => {
    if (amount === 'Custom') return;
    const numeric = amount.replace(/[^\d]/g, '');
    setDonationForm((prev) => ({
      ...prev,
      amount: numeric,
    }));
  };

  const handleSubmitDonation = async () => {
    try {
      setDonationSubmitting(true);
      setDonationMessage('');
      setDonationError('');

      const token = localStorage.getItem('edumate_token');
      if (!token) {
        setDonationError('You must be signed in to submit a donation receipt.');
        return;
      }

      if (!donateInfo.is_enabled) {
        setDonationError('Donations are temporarily disabled.');
        return;
      }

      const amount = Number(donationForm.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        setDonationError('Please enter a valid donation amount.');
        return;
      }

      if (!receiptFile) {
        setDonationError('Please upload your transfer receipt.');
        return;
      }

      const fd = new FormData();
      fd.append('amount', donationForm.amount);
      fd.append('transfer_note', donationForm.transfer_note);
      fd.append('transaction_code', donationForm.transaction_code);
      fd.append('message', donationForm.message);
      fd.append('receipt', receiptFile);

      await api.post('/donations', fd);

      setDonationMessage('Receipt submitted. Please wait for admin confirmation.');
      setDonationForm({
        amount: '',
        transfer_note: '',
        transaction_code: '',
        message: '',
      });
      setReceiptFile(null);

      const input = document.getElementById('donation-receipt') as HTMLInputElement | null;
      if (input) input.value = '';

      await loadMyDonations();
    } catch (err) {
      setDonationError(getApiErrorMessage(err));
    } finally {
      setDonationSubmitting(false);
    }
  };

  const handleOpenDonationReceipt = async (donationId: number) => {
    try {
      setDonationError('');

      const res: any = await api.get(`/donations/${donationId}/receipt`);
      const payload = res?.data ?? res ?? {};
      const url = payload?.url || payload?.data?.url;

      if (!url) {
        setDonationError('Could not load receipt URL.');
        return;
      }

      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setDonationError(getApiErrorMessage(err));
    }
  };

  useEffect(() => {
    let mounted = true;

    const loadDonateInfo = async () => {
      try {
        setLoading(true);

        const res: any = await api.get('/donate/info');
        const payload = res?.data ?? res ?? {};
        const data = payload?.data ?? payload;

        if (!mounted) return;

        setQrVisible(!!data.qr_image_url);

        setDonateInfo({
          account_name: data.account_name || '',
          bank_name: data.bank_name || '',
          account_number: data.account_number || '',
          qr_image_url: data.qr_image_url || '',
          transfer_note: data.transfer_note || '',
          message:
            data.message ||
            'Every contribution helps us maintain servers, pay API costs, store learning materials, and keep building useful features for students and lecturers.',
          is_enabled: data.is_enabled !== false,
          updated_at: data.updated_at || '',
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
    loadMyDonations();
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
          Donations are temporarily disabled.
        </div>
      )}

      {loading && (
        <div className="bg-blue-50 border-b border-blue-200 px-6 py-3 text-sm text-blue-800 text-center">
          Loading donation information...
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
              Support EduMate and help us build a better learning experience.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600">
              {donateInfo.message}
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <a
                href="#donate-levels"
                className="rounded-2xl bg-slate-900 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
              >
                Donate now
              </a>
              <a
                href="#about"
                className="rounded-2xl border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
              >
                Learn more
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
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">About EduMate</p>
            <h2 className="mt-3 text-3xl font-bold text-slate-900">EduMate is a smart learning support platform.</h2>
            <p className="mt-4 text-base leading-8 text-slate-600">
              EduMate helps students and lecturers access materials, review knowledge, take quizzes, study with
              flashcards, and manage learning more easily. We combine technology with real classroom needs to build a
              modern, easy-to-use, and useful learning environment.
            </p>
          </div>

          <div className="rounded-3xl bg-slate-900 p-8 text-white shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-200">Why donate</p>
            <h2 className="mt-3 text-3xl font-bold">Your support helps the project grow sustainably.</h2>
            <ul className="mt-6 space-y-4 text-sm leading-7 text-slate-200">
              <li>• Keep servers running so the system stays stable and responsive.</li>
              <li>• Pay for APIs that power AI features such as quizzes, flashcards, and study support.</li>
              <li>• Store learning materials safely and keep them available for users.</li>
              <li>• Build new features and improve the learning experience over time.</li>
            </ul>
          </div>
        </div>
      </section>

      <section id="donate-levels" className="mx-auto max-w-7xl px-6 py-4 lg:px-10">
        <div className="rounded-[2rem] bg-white p-8 shadow-sm ring-1 ring-slate-200">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">Flexible amounts</p>
            <h2 className="mt-3 text-3xl font-bold text-slate-900">You can donate any amount that works for you.</h2>
            <p className="mt-4 text-base leading-8 text-slate-600">
              Every contribution, no matter how small, helps EduMate keep running and improving. Donating is
              completely voluntary.
            </p>
          </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {donationLevels.map((level) => (
              <button
                key={level.amount}
                type="button"
                onClick={() => handleSelectDonationLevel(level.amount)}
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
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">Transparency</p>
            <h2 className="mt-3 text-3xl font-bold text-slate-900">We use donations transparently.</h2>
            <p className="mt-4 text-base leading-8 text-slate-600">
              Contributions go first to operating and development costs—servers, APIs, document storage, and product
              improvements. We want EduMate to be both useful and trustworthy for our community.
            </p>
          </div>

          <div className="rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">How to donate</p>
            <h2 className="mt-3 text-3xl font-bold text-slate-900">Current donation details.</h2>

            <div className="mt-6 grid gap-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700">
                <span className="block text-slate-500 text-xs mb-1">Account name</span>
                {donateInfo.account_name || 'Not set'}
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700">
                <span className="block text-slate-500 text-xs mb-1">Bank</span>
                {donateInfo.bank_name || 'Not set'}
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700">
                <span className="block text-slate-500 text-xs mb-1">Account number</span>
                {donateInfo.account_number || 'Not set'}
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm font-medium text-slate-700">
                <span className="block text-slate-500 text-xs mb-1">Transfer note</span>
                {donateInfo.transfer_note || 'Not set'}
              </div>
            </div>

            {donateInfo.qr_image_url && qrVisible ? (
              <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-700 mb-3">Donation QR code</p>
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
                Last updated: {new Date(donateInfo.updated_at).toLocaleString('en-US')}
              </p>
            ) : null}

            <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm leading-7 text-slate-600">
              To support EduMate, use the bank details above. Your contribution helps maintain servers, pay API costs, store documents, and fund new features.
            </div>
          </div>
        </div>
      </section>

      {donateInfo.is_enabled && (
        <section className="mx-auto max-w-7xl px-6 pb-16 lg:px-10">
          <div className="rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">
              Confirm donation
            </p>
            <h2 className="mt-3 text-3xl font-bold text-slate-900">
              Upload your receipt for admin verification.
            </h2>
            <p className="mt-4 text-base leading-8 text-slate-600">
              After transferring using the details above, submit the amount and receipt. An admin will review and update the status.
            </p>

            <div className="mt-8 grid gap-6 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">
                  Amount transferred (VND)
                </label>
                <input
                  name="amount"
                  type="number"
                  min="1000"
                  value={donationForm.amount}
                  onChange={handleDonationFormChange}
                  placeholder="e.g. 50000"
                  className="w-full rounded-2xl border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">
                  Transaction code (optional)
                </label>
                <input
                  name="transaction_code"
                  value={donationForm.transaction_code}
                  onChange={handleDonationFormChange}
                  placeholder="e.g. FT123456789"
                  className="w-full rounded-2xl border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
                />
              </div>

              <div className="md:col-span-2">
                <label className="mb-2 block text-sm font-medium text-slate-700">
                  Transfer note
                </label>
                <input
                  name="transfer_note"
                  value={donationForm.transfer_note}
                  onChange={handleDonationFormChange}
                  placeholder={donateInfo.transfer_note || 'e.g. DONATE EDUMATE'}
                  className="w-full rounded-2xl border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
                />
              </div>

              <div className="md:col-span-2">
                <label className="mb-2 block text-sm font-medium text-slate-700">
                  Message (optional)
                </label>
                <textarea
                  name="message"
                  value={donationForm.message}
                  onChange={handleDonationFormChange}
                  rows={3}
                  placeholder="Leave a message for the EduMate team."
                  className="w-full rounded-2xl border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
                />
              </div>

              <div className="md:col-span-2">
                <label className="mb-2 block text-sm font-medium text-slate-700">
                  Transfer receipt
                </label>
                <input
                  id="donation-receipt"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  onChange={handleReceiptChange}
                  className="w-full rounded-2xl border border-slate-300 px-4 py-3 outline-none focus:border-blue-500"
                />
                <p className="mt-2 text-xs text-slate-500">
                  JPG, PNG, WEBP, or PDF. Max 10MB.
                </p>
              </div>
            </div>

            {donationMessage && (
              <div className="mt-6 rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
                {donationMessage}
              </div>
            )}

            {donationError && (
              <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {donationError}
              </div>
            )}

            <div className="mt-8">
              <button
                type="button"
                onClick={handleSubmitDonation}
                disabled={donationSubmitting}
                className="rounded-2xl bg-slate-900 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {donationSubmitting ? 'Submitting...' : 'Submit receipt'}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="mx-auto max-w-7xl px-6 pb-16 lg:px-10">
        <div className="rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">
                Donation history
              </p>
              <h2 className="mt-3 text-3xl font-bold text-slate-900">
                Status of your donations.
              </h2>
            </div>
            <button
              type="button"
              onClick={loadMyDonations}
              className="rounded-2xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Refresh
            </button>
          </div>

          <div className="mt-8 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="px-4 py-3">Submitted</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Admin note</th>
                  <th className="px-4 py-3 text-right">Receipt</th>
                </tr>
              </thead>
              <tbody>
                {historyLoading ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                      Loading history...
                    </td>
                  </tr>
                ) : myDonations.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                      No donations yet.
                    </td>
                  </tr>
                ) : (
                  myDonations.map((item) => (
                    <tr key={item.donation_id} className="border-b border-slate-100">
                      <td className="px-4 py-3">
                        {item.created_at ? new Date(item.created_at).toLocaleString('en-US') : '-'}
                      </td>
                      <td className="px-4 py-3 font-semibold">
                        {Number(item.amount || 0).toLocaleString('en-US')} VND
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-3 py-1 text-xs font-bold ${
                          item.status === 'CONFIRMED'
                            ? 'bg-green-100 text-green-700'
                            : item.status === 'REJECTED'
                              ? 'bg-red-100 text-red-700'
                              : 'bg-amber-100 text-amber-700'
                        }`}>
                          {item.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {item.admin_note || '-'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => handleOpenDonationReceipt(item.donation_id)}
                          className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          View receipt
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {isAdmin && (
        <section className="mx-auto max-w-7xl px-6 pb-16 lg:px-10">
          <div className="rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">
              Donate admin
            </p>
            <h2 className="mt-3 text-3xl font-bold text-slate-900">
              Update donation information
            </h2>
            <p className="mt-4 text-base leading-8 text-slate-600">
              Admin-only area to edit content shown on the Donate page.
            </p>

            <div className="mt-8 grid gap-6 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">
                  Account name
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
                  Bank
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
                  Account number
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
                  Transfer note
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
                  Display message
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
                  Enable donations
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
                {isSaving ? 'Saving...' : 'Save donation info'}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-14 text-center lg:px-10">
          <h2 className="text-3xl font-bold text-slate-900">Thank you for supporting EduMate.</h2>
          <p className="mx-auto mt-4 max-w-3xl text-base leading-8 text-slate-600">
            Your support helps keep the project running and builds a better learning experience for more users in the
            future.
          </p>
        </div>
      </section>
    </div>
  );
}