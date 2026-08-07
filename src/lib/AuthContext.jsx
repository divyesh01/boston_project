import React, { createContext, useState, useContext, useEffect } from 'react';

const AuthContext = createContext();

const LOCAL_USER = {
  id: 'local-admin',
  email: 'admin@localhost',
  full_name: 'Local Admin',
  role: 'admin',
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(LOCAL_USER);
  const [isAuthenticated, setIsAuthenticated] = useState(true);
  const [isLoadingAuth, setIsLoadingAuth] = useState(false);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [authChecked, setAuthChecked] = useState(true);
  const [appPublicSettings, setAppPublicSettings] = useState({ id: 'local', public_settings: {} });

  const checkAppState = async () => {
    // Local mode: always authenticated, no API calls needed
    setUser(LOCAL_USER);
    setIsAuthenticated(true);
    setIsLoadingAuth(false);
    setIsLoadingPublicSettings(false);
    setAuthChecked(true);
    setAuthError(null);
  };

  const checkUserAuth = async () => {
    setUser(LOCAL_USER);
    setIsAuthenticated(true);
    setIsLoadingAuth(false);
    setAuthChecked(true);
  };

  const logout = (shouldRedirect = true) => {
    setUser(null);
    setIsAuthenticated(false);
    if (shouldRedirect) {
      window.location.href = '/';
    }
  };

  const navigateToLogin = () => {
    // No-op in local mode — always authenticated
    console.log('[local] navigateToLogin called, ignoring');
  };

  return (
    <AuthContext.Provider value={{ 
      user, 
      isAuthenticated, 
      isLoadingAuth,
      isLoadingPublicSettings,
      authError,
      appPublicSettings,
      authChecked,
      logout,
      navigateToLogin,
      checkUserAuth,
      checkAppState
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
