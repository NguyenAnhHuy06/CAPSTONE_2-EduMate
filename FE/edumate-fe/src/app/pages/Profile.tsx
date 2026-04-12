import { useEffect, useState } from 'react';
import { User, Mail, Calendar, BookOpen, Award } from 'lucide-react';
import api from '@/services/api';
import { useNotification } from '../pages/NotificationContext';

interface ProfileProps {
    user: any;
    onUserUpdate?: (user: any) => void;
}

function formatJoinDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toISOString().slice(0, 10);
}

export function Profile({ user, onUserUpdate }: ProfileProps) {
    const { showNotification } = useNotification();
    const uid = user?.user_id ?? user?.id;

    const normalizedRole = String(user?.role || '').trim().toUpperCase();
    const isInstructor = normalizedRole === 'LECTURER' || normalizedRole === 'INSTRUCTOR';
    const isStudent = normalizedRole === 'STUDENT';

    const [profileLoading, setProfileLoading] = useState(true);
    const [statsLoading, setStatsLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [fullName, setFullName] = useState(String(user?.name || user?.full_name || ''));
    const [email, setEmail] = useState(String(user?.email || ''));
    const [department, setDepartment] = useState(String(user?.department || ''));
    const [bio, setBio] = useState(String(user?.bio || ''));
    const [joinDate, setJoinDate] = useState(formatJoinDate(user?.created_at));
    const [profileId, setProfileId] = useState(
        String(user?.user_code ?? user?.userCode ?? user?.user_id ?? user?.id ?? 'N/A')
    );

    const [stats, setStats] = useState<Array<{ label: string; value: string }>>([]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (uid == null || uid === '') {
                setProfileLoading(false);
                return;
            }
            setProfileLoading(true);
            try {
                const res: any = await api.get('/profile', { params: { userId: uid } });
                const d = res?.data;
                if (cancelled || !d || typeof d !== 'object') return;
                setFullName(String(d.name || d.full_name || '').trim());
                setEmail(String(d.email || '').trim());
                setDepartment(String(d.department ?? ''));
                setBio(String(d.bio ?? ''));
                setJoinDate(formatJoinDate(d.created_at));
                setProfileId(String(d.user_code ?? d.user_id ?? d.id ?? uid ?? 'N/A'));
                try {
                    localStorage.setItem('edumate_user', JSON.stringify({ ...user, ...d }));
                } catch {
                    /* ignore */
                }
                onUserUpdate?.({ ...user, ...d });
            } catch {
                if (!cancelled) {
                    showNotification({
                        type: 'warning',
                        title: 'Profile',
                        message: 'Could not load profile from server. Showing session data.',
                    });
                }
            } finally {
                if (!cancelled) setProfileLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [uid]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (uid == null || uid === '') {
                setStatsLoading(false);
                return;
            }
            setStatsLoading(true);
            try {
                if (isInstructor) {
                    const [docsRes, historyRes, analyticsRes]: any[] = await Promise.all([
                        api.get('/documents/for-quiz'),
                        api.get('/quizzes/history', {
                            params: { userId: uid, ownerOnly: true, limit: 500 },
                        }),
                        api.get('/quizzes/analytics', { params: { userId: uid, topQuestions: 5 } }),
                    ]);
                    const docs = Array.isArray(docsRes?.data) ? docsRes.data : [];
                    const history = Array.isArray(historyRes?.data) ? historyRes.data : [];
                    const analytics = analyticsRes?.data || analyticsRes || {};
                    const perf = Array.isArray(analytics?.performance) ? analytics.performance : [];
                    const published = perf.filter((p: any) => p?.isPublished).length;
                    const students = Number(analytics?.summary?.totalParticipants ?? 0);
                    if (!cancelled) {
                        setStats([
                            { label: 'Materials Uploaded', value: String(docs.length) },
                            { label: 'Quizzes Created', value: String(history.length) },
                            { label: 'Total Students Reached', value: String(students) },
                            { label: 'Published Quizzes', value: String(published) },
                        ]);
                    }
                } else {
                    const [progRes, histRes]: any[] = await Promise.all([
                        api.get('/progress/summary', { params: { userId: uid } }),
                        api.get('/quizzes/history', { params: { userId: uid, limit: 300 } }),
                    ]);
                    const payload = progRes?.data ?? progRes;
                    const overall = payload?.overall || {};
                    const streak = payload?.streak || {};
                    const history = Array.isArray(histRes?.data) ? histRes.data : [];
                    const completedMaterials = Number(overall.completedMaterials ?? 0);
                    const avg = overall.averageScorePercent;
                    const avgLabel =
                        avg != null && avg !== '' && Number.isFinite(Number(avg))
                            ? `${Math.round(Number(avg))}%`
                            : '—';
                    if (!cancelled) {
                        setStats([
                            { label: 'Materials Studied', value: String(completedMaterials) },
                            { label: 'Quizzes in history', value: String(history.length) },
                            { label: 'Average Score', value: avgLabel },
                            {
                                label: 'Study streak',
                                value: `${Math.max(0, Number(streak.currentDays) || 0)} days`,
                            },
                        ]);
                    }
                }
            } catch {
                if (!cancelled) {
                    setStats(
                        isInstructor
                            ? [
                                  { label: 'Materials Uploaded', value: '—' },
                                  { label: 'Quizzes Created', value: '—' },
                                  { label: 'Total Students Reached', value: '—' },
                                  { label: 'Published Quizzes', value: '—' },
                              ]
                            : [
                                  { label: 'Materials Studied', value: '—' },
                                  { label: 'Quizzes in history', value: '—' },
                                  { label: 'Average Score', value: '—' },
                                  { label: 'Study streak', value: '—' },
                              ]
                    );
                }
            } finally {
                if (!cancelled) setStatsLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [uid, isInstructor]);

    const displayName = fullName.trim() || 'User';
    const roleLabel = isInstructor ? 'Instructor' : isStudent ? 'Student' : 'User';

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (uid == null || uid === '') return;
        setSaving(true);
        try {
            const res: any = await api.patch('/profile', {
                userId: uid,
                fullName: fullName.trim(),
                department: department.trim(),
                bio: bio.trim(),
            });
            const d = res?.data ?? res?.user;
            if (d && typeof d === 'object') {
                setFullName(String(d.name || d.full_name || '').trim());
                setDepartment(String(d.department ?? ''));
                setBio(String(d.bio ?? ''));
                try {
                    localStorage.setItem('edumate_user', JSON.stringify({ ...user, ...d }));
                } catch {
                    /* ignore */
                }
                onUserUpdate?.({ ...user, ...d });
            }
            showNotification({
                type: 'success',
                title: 'Profile',
                message: String(res?.message || 'Saved.'),
            });
        } catch {
            showNotification({
                type: 'error',
                title: 'Profile',
                message: 'Could not save profile.',
            });
        } finally {
            setSaving(false);
        }
    };

    const handleCancel = () => {
        if (uid == null || uid === '') return;
        (async () => {
            setProfileLoading(true);
            try {
                const res: any = await api.get('/profile', { params: { userId: uid } });
                const d = res?.data;
                if (d && typeof d === 'object') {
                    setFullName(String(d.name || d.full_name || '').trim());
                    setEmail(String(d.email || '').trim());
                    setDepartment(String(d.department ?? ''));
                    setBio(String(d.bio ?? ''));
                    setJoinDate(formatJoinDate(d.created_at));
                    setProfileId(String(d.user_code ?? d.user_id ?? d.id ?? uid ?? 'N/A'));
                }
            } catch {
                showNotification({
                    type: 'warning',
                    title: 'Profile',
                    message: 'Could not reload profile.',
                });
            } finally {
                setProfileLoading(false);
            }
        })();
    };

    return (
        <div className="max-w-4xl">
            <h2 className="mb-6">Profile</h2>

            {(profileLoading || statsLoading) && (
                <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-blue-800 text-sm">
                    Loading profile…
                </div>
            )}

            {/* Profile Card */}
            <div className="bg-white rounded-lg border border-gray-200 p-8 mb-6">
                <div className="flex items-start gap-6 mb-8">
                    <div className="w-24 h-24 bg-blue-600 text-white rounded-full flex items-center justify-center text-3xl shrink-0">
                        {displayName
                            .split(' ')
                            .filter(Boolean)
                            .map((n: string) => n[0])
                            .join('')}
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="mb-2">{displayName}</h2>
                        <p className="text-blue-600 mb-4">{roleLabel}</p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="flex items-center gap-2 text-gray-600">
                                <Mail size={18} />
                                <span className="break-all">{email}</span>
                            </div>
                            <div className="flex items-center gap-2 text-gray-600">
                                <Calendar size={18} />
                                <span>Joined {joinDate}</span>
                            </div>
                            <div className="flex items-center gap-2 text-gray-600">
                                <BookOpen size={18} />
                                <span>{department || '—'}</span>
                            </div>
                            <div className="flex items-center gap-2 text-gray-600">
                                <User size={18} />
                                <span>ID: {profileId}</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-6 border-t border-gray-200">
                    {stats.map((stat) => (
                        <div key={stat.label} className="text-center">
                            <h3 className="text-blue-600 mb-1">{stat.value}</h3>
                            <p className="text-gray-600 text-sm">{stat.label}</p>
                        </div>
                    ))}
                </div>
            </div>

            {/* Edit Profile Form */}
            <div className="bg-white rounded-lg border border-gray-200 p-6">
                <h3 className="mb-6">Edit Profile</h3>

                <form className="space-y-4" onSubmit={handleSubmit}>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label htmlFor="fullName" className="block mb-1 font-medium">
                                Full name
                            </label>

                            <input
                                id="fullName"
                                type="text"
                                value={fullName}
                                onChange={(e) => setFullName(e.target.value)}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                            />
                        </div>
                        <div>
                            <label htmlFor="email" className="block mb-1 font-medium">
                                Email
                            </label>
                            <input
                                id="email"
                                type="email"
                                value={email}
                                readOnly
                                disabled
                                className="w-full px-4 py-2 border border-gray-200 rounded-lg bg-gray-50 text-gray-600 cursor-not-allowed"
                            />
                            <p className="text-xs text-gray-500 mt-1">Email cannot be changed here.</p>
                        </div>
                    </div>

                    <div>
                        <label htmlFor="department" className="block mb-1 font-medium">
                            Department
                        </label>
                        <input
                            id="department"
                            type="text"
                            value={department}
                            onChange={(e) => setDepartment(e.target.value)}
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                    </div>

                    <div>
                        <label className="block text-gray-700 mb-2" htmlFor="bio">
                            Bio
                        </label>
                        <textarea
                            id="bio"
                            rows={4}
                            value={bio}
                            onChange={(e) => setBio(e.target.value)}
                            placeholder={
                                isInstructor
                                    ? 'Tell students about yourself and your teaching philosophy...'
                                    : 'Tell others about your learning interests and goals...'
                            }
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                    </div>

                    <div className="flex gap-3">
                        <button
                            type="submit"
                            disabled={saving || profileLoading}
                            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60"
                        >
                            {saving ? 'Saving…' : 'Save Changes'}
                        </button>
                        <button
                            type="button"
                            onClick={handleCancel}
                            disabled={saving}
                            className="px-6 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </form>
            </div>

            {/* Achievements Section (for students) */}
            {isStudent && (
                <div className="bg-white rounded-lg border border-gray-200 p-6 mt-6">
                    <h3 className="mb-6">Achievements</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        {[
                            { name: 'First Quiz', icon: Award, earned: true },
                            { name: '7 Day Streak', icon: Award, earned: true },
                            { name: 'Top 20 Rank', icon: Award, earned: true },
                            { name: 'Quiz Master', icon: Award, earned: false },
                        ].map((achievement) => (
                            <div
                                key={achievement.name}
                                className={`p-4 rounded-lg border-2 text-center ${achievement.earned
                                    ? 'border-blue-600 bg-blue-50'
                                    : 'border-gray-200 bg-gray-50 opacity-50'
                                    }`}
                            >
                                <achievement.icon
                                    className={`mx-auto mb-2 ${achievement.earned ? 'text-blue-600' : 'text-gray-400'
                                        }`}
                                    size={32}
                                />
                                <p className={achievement.earned ? 'text-gray-900' : 'text-gray-500'}>
                                    {achievement.name}
                                </p>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
