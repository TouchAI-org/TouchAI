import { Toaster, toast } from 'sonner';
import { useEffect } from 'react';

// Expose toast globally so inline scripts can call window.__toast.error(...) etc.
export default function ToastProvider() {
    useEffect(() => {
        (window as any).__toast = toast;
    }, []);

    return (
        <Toaster
            position="top-center"
            richColors
            toastOptions={{
                style: {
                    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                    fontSize: '0.875rem',
                },
            }}
        />
    );
}
