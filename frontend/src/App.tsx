import { Spin } from 'antd';
import { Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import MainLayout from './layouts/MainLayout';
import Login from './pages/Login';
import { routes } from './routes';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div style={{ textAlign: 'center', padding: 120 }}><Spin size="large" /></div>;
  if (!user) return <Navigate to={`/login?redirect=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth><MainLayout /></RequireAuth>}>
        {routes.map(({ path, element: El }) => (
          <Route key={path} path={path} element={<Suspense fallback={<Spin />}><El /></Suspense>} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
