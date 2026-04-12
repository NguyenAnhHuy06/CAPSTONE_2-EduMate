import React, { createContext, useContext, useState, useCallback } from 'react';
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react';

interface Notification {
    id: string;
    type: 'success' | 'error' | 'warning' | 'info';
    title?: string;
    message: string;
    duration?: number;
}

interface ConfirmOptions {
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    type?: 'warning' | 'info';
}

interface NotificationContextType {
    showNotification: (notification: Omit<Notification, 'id'>) => void;
    showConfirm: (options: ConfirmOptions) => Promise<boolean>;
    hideNotification: (id: string) => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export function useNotification() {
    const context = useContext(NotificationContext);
    if (!context) {
        throw new Error('useNotification must be used within NotificationProvider');
    }
    return context;
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [confirmDialog, setConfirmDialog] = useState<{
        options: ConfirmOptions;
        resolve: (value: boolean) => void;
    } | null>(null);

    const showNotification = useCallback((notification: Omit<Notification, 'id'>) => {
        const id = Math.random().toString(36).substr(2, 9);
        const newNotification: Notification = {
            ...notification,
            id,
            duration: notification.duration || 3000,
        };

        setNotifications((prev) => [...prev, newNotification]);

        if (newNotification.duration) {
            setTimeout(() => {
                hideNotification(id);
            }, newNotification.duration);
        }
    }, []);

    const showConfirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
        return new Promise((resolve) => {
            setConfirmDialog({ options, resolve });
        });
    }, []);

    const hideNotification = useCallback((id: string) => {
        setNotifications((prev) => prev.filter((n) => n.id !== id));
    }, []);

    const handleConfirmResponse = (response: boolean) => {
        if (confirmDialog) {
            confirmDialog.resolve(response);
            setConfirmDialog(null);
        }
    };

    const getIcon = (type: Notification['type']) => {
        switch (type) {
            case 'success':
                return <CheckCircle size={24} />;
            case 'error':
                return <AlertCircle size={24} />;
            case 'warning':
                return <AlertTriangle size={24} />;
            case 'info':
                return <Info size={24} />;
        }
    };

    const getColorClasses = (type: Notification['type']) => {
        switch (type) {
            case 'success':
                return 'bg-green-50 border-green-200 text-green-800';
            case 'error':
                return 'bg-red-50 border-red-200 text-red-800';
            case 'warning':
                return 'bg-yellow-50 border-yellow-200 text-yellow-800';
            case 'info':
                return 'bg-blue-50 border-blue-200 text-blue-800';
        }
    };

    const getIconColorClasses = (type: Notification['type']) => {
        switch (type) {
            case 'success':
                return 'text-green-600';
            case 'error':
                return 'text-red-600';
            case 'warning':
                return 'text-yellow-600';
            case 'info':
                return 'text-blue-600';
        }
    };

    return (
        <NotificationContext.Provider value={{ showNotification, showConfirm, hideNotification }}>
            {children}

            {/* Toast Notifications */}
            <div className="fixed top-4 right-4 z-50 space-y-2">
                {notifications.map((notification) => (
                    <div
                        key={notification.id}
                        className={`flex items-start gap-3 p-4 rounded-lg border shadow-lg min-w-[320px] max-w-md animate-slideIn ${getColorClasses(
                            notification.type
                        )}`}
                    >
                        <div className={getIconColorClasses(notification.type)}>
                            {getIcon(notification.type)}
                        </div>
                        <div className="flex-1">
                            {notification.title && (
                                <p className="font-semibold mb-1">{notification.title}</p>
                            )}
                            <p className="text-sm">{notification.message}</p>
                        </div>
                        <button
                            type="button"
                            aria-label="Dismiss notification"
                            title="Close"
                            onClick={() => hideNotification(notification.id)}
                            className="text-current opacity-60 hover:opacity-100 transition-opacity"
                        >
                            <X size={18} />
                        </button>
                    </div>
                ))}
            </div>

            {/* Confirm Dialog */}
            {confirmDialog && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-lg shadow-xl max-w-md w-full animate-scaleIn">
                        <div className="p-6">
                            <div className="flex items-start gap-4 mb-4">
                                <div
                                    className={`flex-shrink-0 ${confirmDialog.options.type === 'warning'
                                        ? 'text-yellow-600'
                                        : 'text-blue-600'
                                        }`}
                                >
                                    {confirmDialog.options.type === 'warning' ? (
                                        <AlertTriangle size={28} />
                                    ) : (
                                        <Info size={28} />
                                    )}
                                </div>
                                <div className="flex-1">
                                    {confirmDialog.options.title && (
                                        <h3 className="text-gray-900 mb-2">
                                            {confirmDialog.options.title}
                                        </h3>
                                    )}
                                    <p className="text-gray-600">{confirmDialog.options.message}</p>
                                </div>
                            </div>
                        </div>
                        <div className="flex items-center justify-end gap-3 px-6 py-4 bg-gray-50 rounded-b-lg border-t border-gray-200">
                            <button
                                onClick={() => handleConfirmResponse(false)}
                                className="px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg transition-colors"
                            >
                                {confirmDialog.options.cancelText || 'Cancel'}
                            </button>
                            <button
                                onClick={() => handleConfirmResponse(true)}
                                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                            >
                                {confirmDialog.options.confirmText || 'Confirm'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <style>{`
        @keyframes slideIn {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }

        @keyframes scaleIn {
          from {
            transform: scale(0.95);
            opacity: 0;
          }
          to {
            transform: scale(1);
            opacity: 1;
          }
        }

        .animate-slideIn {
          animation: slideIn 0.3s ease-out;
        }

        .animate-scaleIn {
          animation: scaleIn 0.2s ease-out;
        }
      `}</style>
        </NotificationContext.Provider>
    );
}
