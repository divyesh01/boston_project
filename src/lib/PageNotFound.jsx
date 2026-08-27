import { db } from '@/api/base44Client';

import { useLocation } from 'react-router-dom';

import { useQuery } from '@tanstack/react-query';

export default function PageNotFound() {
    const location = useLocation();
    const pageName = location.pathname.substring(1);

    const { data: authData, isFetched } = useQuery({
        queryKey: ['user'],
        queryFn: async () => {
            try {
                const user = await db.auth.me();
                return { user, isAuthenticated: true };
            } catch {
                return { user: null, isAuthenticated: false };
            }
        }
    });
    
    return (
        <div className="flex min-h-screen items-center justify-center bg-[#040D1A] p-6">
            <div className="w-full max-w-md">
                <div className="space-y-6 text-center">
                    <div className="space-y-2">
                        <h1 className="text-7xl font-light text-slate-600">404</h1>
                        <div className="mx-auto h-0.5 w-16 bg-slate-700"></div>
                    </div>
                    
                    <div className="space-y-3">
                        <h2 className="text-2xl font-medium text-white">
                            Page Not Found
                        </h2>
                        <p className="leading-relaxed text-slate-400">
                            The page <span className="font-medium text-slate-300">"{pageName}"</span> could not be found in this application.
                        </p>
                    </div>
                    
                    {isFetched && authData.isAuthenticated && authData.user?.role === 'admin' && (
                        <div className="mt-8 rounded-lg border border-white/10 bg-[#0F1F35] p-4">
                            <div className="flex items-start space-x-3">
                                <div className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-orange-500/20">
                                    <div className="h-2 w-2 rounded-full bg-orange-400"></div>
                                </div>
                                <div className="space-y-1 text-left">
                                    <p className="text-sm font-medium text-slate-200">Admin Note</p>
                                    <p className="text-sm leading-relaxed text-slate-400">
                                        This could mean that the AI hasn't implemented this page yet. Ask it to implement it in the chat.
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}
                    
                    <div className="pt-6">
                        <button 
                            onClick={() => window.location.href = '/'} 
                            className="inline-flex items-center rounded-lg border border-white/10 bg-[#0A1628] px-4 py-2 text-sm font-medium text-slate-200 transition-colors duration-200 hover:border-white/20 hover:bg-[#1a2a40]"
                        >
                            <svg className="mr-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                            </svg>
                            Go Home
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}