import { Button, Result, Spin } from 'antd';
import { Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import MainLayout from './layouts/MainLayout';
import Login from './pages/Login';
import { routePerm, routes } from './routes';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div style={{ textAlign: 'center', padding: 120 }}><Spin size="large" /></div>;
  if (!user) return <Navigate to={`/login?redirect=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

/** 页面级读权限：无权限时给出说明（找谁开通），不再让页面接口报 403 */
function RequirePerm({ children }: { children: ReactNode }) {
  const { can } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const need = routePerm(loc.pathname);
  if (need && !can(...need.perms)) {
    return (
      <Result
        status="403"
        title="无权访问此页面"
        subTitle={`该页面需要“${need.label}”权限。如工作需要，请联系系统管理员在“用户与角色”中为你分配相应角色。`}
        extra={<Button type="primary" onClick={() => nav('/')}>回到我的工作台</Button>}
      />
    );
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth><MainLayout /></RequireAuth>}>
        {routes.map(({ path, element: El }) => (
          <Route key={path} path={path} element={<RequirePerm><Suspense fallback={<Spin />}><El /></Suspense></RequirePerm>} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
