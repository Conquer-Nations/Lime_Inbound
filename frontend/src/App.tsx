import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { VendorAuthProvider } from './auth/VendorAuthContext'
import LoginPage from './pages/LoginPage'
import OperatorPage from './pages/OperatorPage'
import ManagerPage from './pages/ManagerPage'
import VendorIntakePage from './pages/VendorIntakePage'
import VendorLoginPage from './pages/VendorLoginPage'
import VendorRegisterPage from './pages/VendorRegisterPage'
import VendorForgotPasswordPage from './pages/VendorForgotPasswordPage'
import VendorWelcomePage from './pages/VendorWelcomePage'
import DODetailPage from './pages/DODetailPage'
import LotDetailPage from './pages/LotDetailPage'

function RequireAuth({
  role,
  children,
}: {
  role: 'operator' | 'manager_or_dev'
  children: React.ReactNode
}) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (role === 'operator' && user.role !== 'operator')
    return <Navigate to="/manager" replace />
  if (role === 'manager_or_dev' && user.role === 'operator')
    return <Navigate to="/operator" replace />
  return <>{children}</>
}

function Home() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  return <Navigate to={user.role === 'operator' ? '/operator' : '/manager'} replace />
}

export default function App() {
  return (
    <AuthProvider>
      <VendorAuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/vendor" element={<VendorWelcomePage />} />
            <Route path="/vendor-intake" element={<VendorIntakePage />} />
            <Route path="/vendor/login" element={<VendorLoginPage />} />
            <Route path="/vendor/register" element={<VendorRegisterPage />} />
            <Route
              path="/vendor/forgot-password"
              element={<VendorForgotPasswordPage />}
            />
            <Route
              path="/operator"
              element={
                <RequireAuth role="operator">
                  <OperatorPage />
                </RequireAuth>
              }
            />
            <Route
              path="/manager"
              element={
                <RequireAuth role="manager_or_dev">
                  <ManagerPage />
                </RequireAuth>
              }
            />
            <Route
              path="/manager/dos/:do_id"
              element={
                <RequireAuth role="manager_or_dev">
                  <DODetailPage />
                </RequireAuth>
              }
            />
            <Route
              path="/manager/lots/:lot_id"
              element={
                <RequireAuth role="manager_or_dev">
                  <LotDetailPage />
                </RequireAuth>
              }
            />
            <Route path="/" element={<Home />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </VendorAuthProvider>
    </AuthProvider>
  )
}
