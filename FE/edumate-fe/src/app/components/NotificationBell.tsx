import { useCallback, useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import api from '@/services/api';

type ServerNotification = {
  notification_id: number;
  user_id?: number;
  type: 'info' | 'success' | 'warning' | 'error' | string;
  title?: string;
  content?: string;
  message?: string;
  is_read?: boolean;
  created_at?: string;
};

type LocalNotification = {
  id: string;
  type: 'quiz' | 'flashcard';
  title: string;
  documentId?: number | null;
  s3Key?: string;
  createdAt: number;
};

type NotificationBellProps = {
  localNotifications?: LocalNotification[];
  onClearLocalNotifications?: () => void;
  onOpenLocalNotification?: (notification: LocalNotification) => void;
};

export function NotificationBell({
  localNotifications = [],
  onClearLocalNotifications,
  onOpenLocalNotification,
}: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [serverNotifs, setServerNotifs] = useState<ServerNotification[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchServerNotifications = useCallback(async () => {
    try {
      const token = localStorage.getItem('edumate_token');
      if (!token) {
        setServerNotifs([]);
        return;
      }

      setLoading(true);

      const res: any = await api.get('/notifications');
      const payload = res?.data ?? res ?? {};
      const list = Array.isArray(payload) ? payload : payload.data || [];

      setServerNotifs(list);
    } catch (err) {
      console.error('Failed to fetch notifications:', err);
      setServerNotifs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const clearServerNotifications = useCallback(async () => {
    try {
      await api.patch('/notifications/read-all');
      setServerNotifs([]);
    } catch (err) {
      console.error('Failed to clear server notifications:', err);
    }
  }, []);

  useEffect(() => {
    fetchServerNotifications();
  }, [fetchServerNotifications]);

  const totalCount = serverNotifs.length + localNotifications.length;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          fetchServerNotifications();
          setOpen((v) => !v);
        }}
        className="relative p-2 rounded-lg border border-gray-200 hover:bg-gray-50"
        aria-label="Open notifications"
      >
        <Bell size={18} className="text-gray-700" />
        {totalCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-blue-600 text-white text-[10px] flex items-center justify-center">
            {totalCount > 99 ? '99+' : totalCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-white border border-gray-200 rounded-xl shadow-xl z-[90]">
          <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-900">Notifications</p>

            {totalCount > 0 && (
              <button
                type="button"
                onClick={async () => {
                  onClearLocalNotifications?.();
                  await clearServerNotifications();
                }}
                className="text-xs text-blue-600 hover:text-blue-700"
              >
                Clear
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-auto">
            {loading ? (
              <p className="text-sm text-gray-500 px-3 py-4">
                Loading notifications...
              </p>
            ) : totalCount === 0 ? (
              <p className="text-sm text-gray-500 px-3 py-4">
                No notifications yet.
              </p>
            ) : (
              <>
                {serverNotifs.map((n) => {
                  const type = String(n.type || '').toLowerCase();

                  const typeClass =
                    type === 'success'
                      ? 'bg-green-50/60'
                      : type === 'error'
                        ? 'bg-red-50/60'
                        : type === 'warning'
                          ? 'bg-yellow-50/60'
                          : 'bg-blue-50/60';

                  const labelClass =
                    type === 'success'
                      ? 'text-green-700'
                      : type === 'error'
                        ? 'text-red-700'
                        : type === 'warning'
                          ? 'text-yellow-700'
                          : 'text-blue-700';

                  return (
                    <div
                      key={`server-${n.notification_id}`}
                      className={`w-full text-left px-3 py-2 border-b border-gray-100 last:border-0 ${typeClass}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm text-gray-900 font-medium">
                          {n.title || 'Notification'}
                        </p>
                        <span className={`text-[10px] font-bold uppercase ${labelClass}`}>
                          {type || 'info'}
                        </span>
                      </div>

                      <p className="text-xs text-gray-600">
                        {n.content || n.message || ''}
                      </p>

                      {n.created_at ? (
                        <p className="text-[11px] text-gray-400 mt-0.5">
                          {new Date(n.created_at).toLocaleString('vi-VN')}
                        </p>
                      ) : null}
                    </div>
                  );
                })}

                {localNotifications.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => {
                      onOpenLocalNotification?.(n);
                      setOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors"
                  >
                    <p className="text-sm text-gray-900">
                      {n.type === 'quiz'
                        ? 'Quiz created successfully'
                        : 'Flashcards created successfully'}
                    </p>
                    <p className="text-xs text-gray-600 truncate">
                      {n.title}
                    </p>
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      {new Date(n.createdAt).toLocaleString('vi-VN')}
                    </p>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}