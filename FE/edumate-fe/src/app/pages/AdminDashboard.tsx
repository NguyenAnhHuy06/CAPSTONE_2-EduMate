import { useState, useEffect } from 'react';
import { 
  Users, 
  ShieldCheck, 
  Activity, 
  BookOpen, 
  UserPlus, 
  UserMinus, 
  CheckCircle, 
  XCircle, 
  Clock, 
  Briefcase,
  Search,
  RefreshCw,
  Home
} from 'lucide-react';
import { Sidebar } from './Sidebar';
import { Profile } from './Profile';
import api from '../../services/api';
import { Heart } from 'lucide-react';

type AdminTab = 'overview' | 'users' | 'moderation' | 'donations' | 'logs' | 'profile';

interface AdminDashboardProps {
  user: any;
  onLogout: () => void;
  onOpenDonate?: () => void;
}

export function AdminDashboard({ user, onLogout, onOpenDonate }: AdminDashboardProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  
  // Data States
  const [stats, setStats] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [pendingDocs, setPendingDocs] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [donations, setDonations] = useState<any[]>([]);
  const [donationStatus, setDonationStatus] = useState<'PENDING' | 'CONFIRMED' | 'REJECTED' | 'ALL'>('PENDING');

  const menuItems = [
    { id: 'overview', label: 'Overview', icon: Home },
    { id: 'users', label: 'User Management', icon: Users },
    { id: 'moderation', label: 'Document Moderation', icon: ShieldCheck },
    { id: 'donations', label: 'Donation Management', icon: Heart },
    { id: 'logs', label: 'Activity Logs', icon: Activity },
    { id: 'donate', label: 'Donate', icon: Heart },
    { id: 'profile', label: 'Profile', icon: UserPlus },
  ];

  const fetchData = async () => {
    setLoading(true);
    try {
      if (activeTab === 'overview') {
        const res: any = await api.get('/admin/stats');
        setStats(res.data);
      } else if (activeTab === 'users') {
        const res: any = await api.get('/admin/users');
        setUsers(res.data || []);
      } else if (activeTab === 'moderation') {
        const res: any = await api.get('/admin/documents/pending');
        setPendingDocs(res.data || []);
      } else if (activeTab === 'logs') {
        const res: any = await api.get('/admin/activity-logs?limit=50');
        setLogs(res.data || []);
      } else if (activeTab === 'donations') {
        const query = donationStatus === 'ALL' ? '' : `?status=${donationStatus}`;
        const res: any = await api.get(`/donations/admin${query}`);
        setDonations(res.data || []);
      }
    } catch (err) {
      console.error('Error fetching admin data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [activeTab, donationStatus]);

  const handleUpdateRole = async (userId: string, newRole: string) => {
    try {
      await api.patch(`/admin/users/${userId}/role`, { role: newRole });
      setUsers(users.map(u => u.user_id === userId ? { ...u, role: newRole } : u));
    } catch (err) {
      alert('Failed to update role');
    }
  };

  const handleToggleUserStatus = async (userId: string, currentStatus: boolean) => {
    try {
      await api.patch(`/admin/users/${userId}/status`, { is_active: !currentStatus });
      setUsers(users.map(u => u.user_id === userId ? { ...u, is_active: !currentStatus } : u));
    } catch (err) {
      alert('Failed to toggle status');
    }
  };

  const handleModerateDoc = async (docId: number, action: 'verify' | 'reject') => {
    try {
      await api.patch(`/documents/${docId}/${action}`);
      setPendingDocs(pendingDocs.filter(d => d.document_id !== docId));
      if (activeTab === 'overview') fetchData(); // Refresh stats
    } catch (err) {
      alert(`Failed to ${action} document`);
    }
  };

  const handleOpenDonationReceipt = async (donationId: number) => {
    try {
      const res: any = await api.get(`/donations/${donationId}/receipt`);
      const payload = res?.data ?? res ?? {};
      const url = payload?.url || payload?.data?.url;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      alert('Failed to open receipt');
    }
  };

  const handleConfirmDonation = async (donationId: number) => {
    try {
      await api.patch(`/donations/${donationId}/confirm`, {
        admin_note: 'Đã xác nhận khoản ủng hộ.',
      });
      fetchData();
    } catch (err) {
      alert('Failed to confirm donation');
    }
  };

  const handleRejectDonation = async (donationId: number) => {
    try {
      const reason = window.prompt(
        'Reason for rejection:',
        'Biên lai không hợp lệ hoặc chưa tìm thấy giao dịch.'
      );

      await api.patch(`/donations/${donationId}/reject`, {
        admin_note: reason || 'Đã từ chối khoản ủng hộ.',
      });

      fetchData();
    } catch (err) {
      alert('Failed to reject donation');
    }
  };

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar
        menuItems={menuItems}
        activeItem={activeTab}
        onMenuItemClick={(id) => {
          if (id === 'donate') {
            onOpenDonate?.();
            return;
          }
          setActiveTab(id as AdminTab);
        }}
        onLogout={onLogout}
        userRole="Administrator"
        userName={user.name}
        userEmail={user.email}
      />

      <div className="flex-1 overflow-auto">
        {/* Top Bar */}
        <div className="bg-white border-b border-gray-200 p-4 flex justify-between items-center sticky top-0 z-10">
          <h2 className="text-xl font-bold flex items-center gap-2">
            Admin Panel <span className="text-gray-400 text-sm font-normal">| {menuItems.find(m => m.id === activeTab)?.label}</span>
          </h2>
          <button 
            onClick={fetchData} 
            className="p-2 text-gray-500 hover:text-blue-600 rounded-full hover:bg-blue-50 transition-colors"
            title="Refresh Data"
          >
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        <div className="p-6">
          {activeTab === 'overview' && (
            <div className="space-y-8">
              {/* Stats Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {[
                  { label: 'Total Users', value: stats?.users?.total || 0, sub: `${stats?.users?.verified || 0} verified`, icon: Users, color: 'text-blue-600', bg: 'bg-blue-100' },
                  { label: 'Documents', value: stats?.documents || 0, sub: `${stats?.document_segments || 0} chunks indexed`, icon: BookOpen, color: 'text-green-600', bg: 'bg-green-100' },
                  { label: 'Quizzes', value: stats?.quizzes || 0, sub: 'Generated by students', icon: Briefcase, color: 'text-purple-600', bg: 'bg-purple-100' },
                  { label: 'AI Availability', value: 'Active', sub: 'Gemini 2.0 Flash', icon: ShieldCheck, color: 'text-orange-600', bg: 'bg-orange-100' },
                ].map(stat => (
                  <div key={stat.label} className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
                    <div className="flex items-center justify-between mb-4">
                      <div className={`p-3 rounded-lg ${stat.bg} ${stat.color}`}>
                        <stat.icon size={24} />
                      </div>
                    </div>
                    <p className="text-gray-500 text-sm mb-1">{stat.label}</p>
                    <h3 className="text-2xl font-bold">{stat.value}</h3>
                    <p className="text-xs text-gray-400 mt-1">{stat.sub}</p>
                  </div>
                ))}
              </div>

              {/* System Health / Quick Info */}
              <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
                <h3 className="mb-4">System Overview</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="space-y-4">
                    <div className="flex justify-between items-center py-2 border-b border-gray-50">
                      <span className="text-gray-600">Database Status</span>
                      <span className="text-green-600 flex items-center gap-1 text-sm font-medium"><CheckCircle size={14} /> Connected</span>
                    </div>
                    <div className="flex justify-between items-center py-2 border-b border-gray-50">
                      <span className="text-gray-600">Storage (S3)</span>
                      <span className="text-green-600 flex items-center gap-1 text-sm font-medium"><CheckCircle size={14} /> Available</span>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div className="flex justify-between items-center py-2 border-b border-gray-50">
                      <span className="text-gray-600">Vector Indexing</span>
                      <span className="text-green-600 flex items-center gap-1 text-sm font-medium"><CheckCircle size={14} /> Synchronized</span>
                    </div>
                    <div className="flex justify-between items-center py-2 border-b border-gray-50">
                      <span className="text-gray-600">Auth System</span>
                      <span className="text-green-600 flex items-center gap-1 text-sm font-medium"><CheckCircle size={14} /> JWT Flow Active</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'users' && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="p-4 border-b border-gray-100 flex justify-between items-center">
                <h3 className="text-lg font-semibold">Registered Users</h3>
                <div className="relative">
                  <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input type="text" placeholder="Search by email..." className="pl-10 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none" />
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-100">
                      <th className="p-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Email / Code</th>
                      <th className="p-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Full Name</th>
                      <th className="p-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Role</th>
                      <th className="p-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                      <th className="p-4 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.user_id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                        <td className="p-4">
                          <p className="text-sm font-medium text-gray-900">{u.email}</p>
                          <p className="text-xs text-gray-500">{u.user_code || 'No code'}</p>
                        </td>
                        <td className="p-4 text-sm text-gray-700">{u.full_name}</td>
                        <td className="p-4">
                          <select 
                            value={u.role} 
                            onChange={(e) => handleUpdateRole(u.user_id, e.target.value)}
                            className="text-xs border border-gray-200 rounded p-1 bg-white focus:ring-2 focus:ring-blue-500 outline-none"
                          >
                            <option value="STUDENT">Student</option>
                            <option value="LECTURER">Lecturer</option>
                            <option value="ADMIN">Admin</option>
                          </select>
                        </td>
                        <td className="p-4">
                          <span className={`px-2 py-1 rounded-full text-[10px] font-bold ${u.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                            {u.is_active ? 'ACTIVE' : 'DEACTIVATED'}
                          </span>
                        </td>
                        <td className="p-4 text-right">
                          <button 
                            onClick={() => handleToggleUserStatus(u.user_id, u.is_active)}
                            className={`p-2 rounded-lg transition-colors ${u.is_active ? 'text-red-600 hover:bg-red-50' : 'text-green-600 hover:bg-green-50'}`}
                            title={u.is_active ? 'Deactivate' : 'Activate'}
                          >
                            {u.is_active ? <UserMinus size={18} /> : <UserPlus size={18} />}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'moderation' && (
            <div className="space-y-6">
              <div className="bg-yellow-50 border border-yellow-100 p-4 rounded-lg flex items-start gap-3">
                <Clock className="text-yellow-600 shrink-0" size={20} />
                <p className="text-yellow-800 text-sm">
                  Documents listed here are pending review. Verification triggers the AI indexing and embedding process.
                </p>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                <table className="w-full text-left">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-100">
                      <th className="p-4 text-xs font-semibold text-gray-500 uppercase">Title / Course</th>
                      <th className="p-4 text-xs font-semibold text-gray-500 uppercase">Uploader</th>
                      <th className="p-4 text-xs font-semibold text-gray-500 uppercase">Date</th>
                      <th className="p-4 text-xs font-semibold text-gray-500 uppercase text-right">Moderation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingDocs.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="p-8 text-center text-gray-400">No documents pending moderation.</td>
                      </tr>
                    ) : pendingDocs.map((doc) => (
                      <tr key={doc.document_id} className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="py-3 px-4 font-medium text-sm">
                          <div className="text-gray-900">{doc.title}</div>
                          {(doc.course_code || doc.course_name) && (
                            <div className="text-[11px] text-gray-400 font-normal mt-0.5">
                              {doc.course_code || ''} {doc.course_code && doc.course_name ? '•' : ''} {doc.course_name || ''}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-sm">{doc.uploader_name || 'System'}</td>
                        <td className="py-3 px-4 text-sm text-gray-400">{new Date(doc.created_at).toLocaleDateString()}</td>
                        <td className="py-3 px-4 text-right">
                          <div className="flex justify-end gap-2">
                            <button 
                              onClick={() => handleModerateDoc(doc.document_id, 'verify')}
                              className="flex items-center gap-1 px-2.5 py-1 bg-green-600 text-white rounded text-[11px] font-medium hover:bg-green-700 transition-colors"
                            >
                              <CheckCircle size={13} /> Verify
                            </button>
                            <button 
                              onClick={() => handleModerateDoc(doc.document_id, 'reject')}
                              className="flex items-center gap-1 px-2.5 py-1 bg-red-600 text-white rounded text-[11px] font-medium hover:bg-red-700 transition-colors"
                            >
                              <XCircle size={13} /> Reject
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'logs' && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
               <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                <h3 className="text-md font-semibold text-gray-700">Recent Activity Logs</h3>
              </div>
              <div className="max-h-[600px] overflow-y-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-100 sticky top-0">
                      <th className="p-4 text-xs font-semibold text-gray-500 uppercase">User</th>
                      <th className="p-4 text-xs font-semibold text-gray-500 uppercase">Action</th>
                      <th className="p-4 text-xs font-semibold text-gray-500 uppercase">Target</th>
                      <th className="p-4 text-xs font-semibold text-gray-500 uppercase">Timestamp</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {logs.map((log) => (
                      <tr key={log.log_id} className="text-sm hover:bg-gray-50">
                        <td className="p-4 text-gray-900 font-medium">{log.email || 'System'}</td>
                        <td className="p-4">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            log.action === 'LOGIN' ? 'bg-blue-100 text-blue-600' :
                            log.action === 'UPLOAD' ? 'bg-green-100 text-green-600' :
                            log.action === 'VERIFY' ? 'bg-purple-100 text-purple-600' :
                            'bg-gray-100 text-gray-600'
                          }`}>
                            {log.action}
                          </span>
                        </td>
                        <td className="p-4 text-gray-500 max-w-xs truncate">{log.target_id || '-'}</td>
                        <td className="p-4 text-gray-400 text-xs">{new Date(log.created_at).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'profile' && (
            <Profile user={user} />
          )}

          {activeTab === 'donations' && (
            <div className="space-y-6">
              <div className="bg-blue-50 border border-blue-100 p-4 rounded-lg flex items-start gap-3">
                <Heart className="text-blue-600 shrink-0" size={20} />
                <p className="text-blue-800 text-sm">
                  Các khoản donate đang chờ xác nhận. Admin cần kiểm tra biên lai với giao dịch ngân hàng trước khi xác nhận.
                </p>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="p-4 border-b border-gray-100 flex flex-wrap gap-3 justify-between items-center">
                  <h3 className="text-lg font-semibold">
                    Donation Requests
                  </h3>

                  <div className="flex items-center gap-2">
                    <select
                      value={donationStatus}
                      onChange={(e) => setDonationStatus(e.target.value as 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'ALL')}
                      className="px-3 py-2 text-sm rounded-lg border border-gray-200 bg-white outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="PENDING">Pending</option>
                      <option value="CONFIRMED">Confirmed</option>
                      <option value="REJECTED">Rejected</option>
                      <option value="ALL">All</option>
                    </select>

                    <button
                      onClick={fetchData}
                      className="px-3 py-2 text-sm rounded-lg border border-gray-200 hover:bg-gray-50"
                    >
                      Refresh
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-100">
                        <th className="p-4 text-xs font-semibold text-gray-500 uppercase">Donor</th>
                        <th className="p-4 text-xs font-semibold text-gray-500 uppercase">Amount</th>
                        <th className="p-4 text-xs font-semibold text-gray-500 uppercase">Transfer Info</th>
                        <th className="p-4 text-xs font-semibold text-gray-500 uppercase">Date</th>
                        <th className="p-4 text-xs font-semibold text-gray-500 uppercase">Status</th>
                        <th className="p-4 text-xs font-semibold text-gray-500 uppercase text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {donations.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="p-8 text-center text-gray-400">
                            No donations found.
                          </td>
                        </tr>
                      ) : (
                        donations.map((d) => (
                          <tr key={d.donation_id} className="border-b border-gray-50 hover:bg-gray-50">
                            <td className="p-4">
                              <div className="font-medium text-gray-900">
                                {d.donor_name || 'Unknown'}
                              </div>
                              <div className="text-xs text-gray-500">
                                {d.donor_email || '-'}
                              </div>
                            </td>
                            <td className="p-4 font-semibold">
                              {Number(d.amount || 0).toLocaleString('vi-VN')}đ
                            </td>
                            <td className="p-4 text-sm">
                              <div className="text-gray-900">
                                Note: {d.transfer_note || '-'}
                              </div>
                              <div className="text-xs text-gray-500">
                                Transaction: {d.transaction_code || '-'}
                              </div>
                              {d.message ? (
                                <div className="text-xs text-gray-500 mt-1">
                                  Message: {d.message}
                                </div>
                              ) : null}
                            </td>
                            <td className="p-4 text-sm text-gray-400">
                              {d.created_at ? new Date(d.created_at).toLocaleString('vi-VN') : '-'}
                            </td>
                            <td className="p-4">
                              <span className={`px-2 py-1 rounded-full text-[10px] font-bold ${
                                d.status === 'CONFIRMED'
                                  ? 'bg-green-100 text-green-700'
                                  : d.status === 'REJECTED'
                                    ? 'bg-red-100 text-red-700'
                                    : 'bg-yellow-100 text-yellow-700'
                              }`}>
                                {d.status || 'PENDING'}
                              </span>
                            </td>
                            <td className="p-4 text-right">
                              <div className="flex justify-end gap-2">
                                <button
                                  onClick={() => handleOpenDonationReceipt(d.donation_id)}
                                  className="px-2.5 py-1 bg-gray-700 text-white rounded text-[11px] font-medium hover:bg-gray-800"
                                >
                                  Receipt
                                </button>

                                {d.status === 'PENDING' ? (
                                  <>
                                    <button
                                      onClick={() => handleConfirmDonation(d.donation_id)}
                                      className="flex items-center gap-1 px-2.5 py-1 bg-green-600 text-white rounded text-[11px] font-medium hover:bg-green-700"
                                    >
                                      <CheckCircle size={13} /> Confirm
                                    </button>

                                    <button
                                      onClick={() => handleRejectDonation(d.donation_id)}
                                      className="flex items-center gap-1 px-2.5 py-1 bg-red-600 text-white rounded text-[11px] font-medium hover:bg-red-700"
                                    >
                                      <XCircle size={13} /> Reject
                                    </button>
                                  </>
                                ) : (
                                  <span className="px-2.5 py-1 rounded text-[11px] font-medium bg-gray-100 text-gray-500">
                                    No action
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
