import { Navigate, useNavigate } from 'react-router-dom'
import { vendorMasterListApi } from '../api/client'
import { useVendorAuth } from '../auth/VendorAuthContext'
import MasterList from '../components/MasterList'
import VendorPortalChrome from '../components/VendorPortalChrome'

/**
 * Vendor-facing master inventory sheet. Same layout as the manager view,
 * but the dataset is JWT-scoped — a direct-brand login (e.g. company =
 * "Lime") sees only Lime rows; an account-level login (e.g. company =
 * "TQL Trading Inc.") sees every brand rolling up to that Account.
 *
 * All the heavy table rendering lives in <MasterList />; we just pass
 * vendor-flavored data loaders so it hits /vendor/master-list instead
 * of the manager endpoint. The brand-filter dropdown is populated from
 * /vendor/master-list/brands so a TQL user only sees their 4 brands as
 * dropdown options, never other tenants'.
 */
export default function VendorMasterListPage() {
  const { isLoggedIn } = useVendorAuth()
  const nav = useNavigate()

  if (!isLoggedIn) return <Navigate to="/vendor/login" replace />

  return (
    <VendorPortalChrome
      breadcrumbCurrent="Master inventory"
      onBack={() => nav('/vendor-intake')}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10">
        <MasterList
          loadRows={(params) => vendorMasterListApi.list(params)}
          loadBrands={() => vendorMasterListApi.brandsWithIds()}
        />
      </div>
    </VendorPortalChrome>
  )
}
