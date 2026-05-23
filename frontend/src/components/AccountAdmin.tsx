import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../api/client'
import type {
  AccountRead,
  AccountCreate,
  AccountUpdate,
  CustomerRead,
} from '../api/client'

/**
 * Account hierarchy admin — Conquer Nation's commercial structure.
 *
 *   Account      (we bill them, e.g. TQL)
 *     └─ Brand   (their product line we warehouse, e.g. Lime, Pan America)
 *          └─ SKU
 *
 * Two cards on this screen:
 *   1. Accounts list — billing entities we have a service contract with.
 *      Each row expands to show the brands attached to that account.
 *   2. Brands list — every product-owner brand, with an inline Account
 *      dropdown so brands can be (re)assigned without leaving the page.
 */
export default function AccountAdmin() {
  const [accounts, setAccounts] = useState<AccountRead[] | null>(null)
  const [customers, setCustomers] = useState<CustomerRead[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [showAccountForm, setShowAccountForm] = useState(false)
  const [editingAccount, setEditingAccount] = useState<AccountRead | null>(null)
  const [showBrandForm, setShowBrandForm] = useState(false)
  const [editingBrand, setEditingBrand] = useState<CustomerRead | null>(null)

  function reload() {
    setError(null)
    Promise.all([api.listAccounts(), api.listManagerCustomers()])
      .then(([a, c]) => {
        setAccounts(a)
        setCustomers(c)
      })
      .catch((e) => setError(String(e?.detail || e)))
  }

  useEffect(reload, [])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  async function handleAccountDelete(a: AccountRead) {
    if (
      !confirm(
        `Delete account "${a.name}"?\nOnly succeeds if no brands are attached.`,
      )
    )
      return
    try {
      await api.deleteAccount(a.id)
      showToast(`Deleted ${a.name}`)
      reload()
    } catch (e: unknown) {
      setError(String((e as { detail?: string })?.detail ?? e))
    }
  }

  async function handleBrandAccountChange(
    brand: CustomerRead,
    newAccountId: number | null,
  ) {
    try {
      await api.updateCustomer(brand.id, { account_id: newAccountId })
      showToast(
        newAccountId
          ? `${brand.name} → ${accounts?.find((a) => a.id === newAccountId)?.name ?? 'account'}`
          : `${brand.name} unlinked from account`,
      )
      reload()
    } catch (e: unknown) {
      setError(String((e as { detail?: string })?.detail ?? e))
    }
  }

  return (
    <div className="space-y-5">
      {error && (
        <div
          role="alert"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2.5"
        >
          <span className="font-semibold">Error:</span> {error}
        </div>
      )}

      {/* Accounts card */}
      <Card>
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
              Billing
            </div>
            <h2 className="text-xl font-bold text-[#1B4676] mt-0.5">Accounts</h2>
          </div>
          <span className="text-xs text-slate-500">
            Companies Conquer Nation has a service contract with (we bill them).
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => {
              setEditingAccount(null)
              setShowAccountForm(true)
            }}
            className="inline-flex items-center gap-1.5 bg-[#0093D0] hover:bg-[#00A8E8] text-white text-sm font-semibold rounded-full px-4 py-1.5 shadow-[0_6px_18px_-4px_rgba(0,147,208,0.4)]"
          >
            <span>+</span>
            <span>New account</span>
          </button>
        </div>

        {!accounts ? (
          <LoadingHint />
        ) : accounts.length === 0 ? (
          <div className="mt-4 rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400 italic">
            No accounts yet — click "New account" and add e.g. TQL.
          </div>
        ) : (
          <div className="mt-4 rounded-md border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[10.5px] uppercase text-slate-500 border-b border-slate-200">
                <tr>
                  <Th>Account</Th>
                  <Th>Billing email</Th>
                  <Th align="right">Brands</Th>
                  <Th>Notes</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {accounts.map((a) => (
                  <tr key={a.id} className="hover:bg-[#0093D0]/5">
                    <td className="px-3 py-2 font-bold text-[#1B4676]">
                      {a.name}
                    </td>
                    <td className="px-3 py-2 text-slate-700 font-mono text-xs">
                      {a.billing_email ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-700">
                      {a.customer_count}
                    </td>
                    <td className="px-3 py-2 text-slate-500 max-w-xs truncate">
                      {a.notes ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingAccount(a)
                            setShowAccountForm(true)
                          }}
                          className="text-xs font-bold text-[#1B4676] hover:text-[#0093D0]"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAccountDelete(a)}
                          className="text-xs font-bold text-red-600 hover:text-red-800"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Brands card */}
      <Card>
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
              Product owners
            </div>
            <h2 className="text-xl font-bold text-[#1B4676] mt-0.5">Brands</h2>
          </div>
          <span className="text-xs text-slate-500">
            Companies whose physical inventory lives on our floor. Attach to a
            billing account so invoicing rolls up correctly.
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => {
              setEditingBrand(null)
              setShowBrandForm(true)
            }}
            className="inline-flex items-center gap-1.5 bg-[#1B4676] hover:bg-[#224E72] text-white text-sm font-semibold rounded-full px-4 py-1.5"
          >
            <span>+</span>
            <span>New brand</span>
          </button>
        </div>

        {!customers ? (
          <LoadingHint />
        ) : customers.length === 0 ? (
          <div className="mt-4 rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400 italic">
            No brands yet — add e.g. Lime, Pan America, Boviet Solar.
          </div>
        ) : (
          <div className="mt-4 rounded-md border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[10.5px] uppercase text-slate-500 border-b border-slate-200">
                <tr>
                  <Th>Brand</Th>
                  <Th>Account</Th>
                  <Th>Contact email</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {customers.map((c) => (
                  <tr key={c.id} className="hover:bg-[#0093D0]/5">
                    <td className="px-3 py-2 font-bold text-[#1B4676]">
                      {c.name}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={c.account_id ?? ''}
                        onChange={(e) =>
                          handleBrandAccountChange(
                            c,
                            e.target.value ? Number(e.target.value) : null,
                          )
                        }
                        className="border border-slate-300 rounded-md px-2 py-1 text-sm text-slate-700 focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
                      >
                        <option value="">— direct bill —</option>
                        {accounts?.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-600">
                      {c.contact_email ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingBrand(c)
                          setShowBrandForm(true)
                        }}
                        className="text-xs font-bold text-[#1B4676] hover:text-[#0093D0]"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {showAccountForm && (
        <AccountFormModal
          initial={editingAccount}
          onClose={() => setShowAccountForm(false)}
          onSaved={(a, action) => {
            setShowAccountForm(false)
            showToast(
              action === 'created' ? `Created ${a.name}` : `Updated ${a.name}`,
            )
            reload()
          }}
        />
      )}

      {showBrandForm && (
        <BrandFormModal
          initial={editingBrand}
          accounts={accounts ?? []}
          onClose={() => setShowBrandForm(false)}
          onSaved={(c, action) => {
            setShowBrandForm(false)
            showToast(
              action === 'created' ? `Created ${c.name}` : `Updated ${c.name}`,
            )
            reload()
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 bg-emerald-700 text-white px-4 py-2 rounded-md shadow-lg z-50 flex items-center gap-2">
          <span aria-hidden>✓</span>
          <span>{toast}</span>
        </div>
      )}
    </div>
  )
}

// ─── Account form modal ───────────────────────────────────────────────

function AccountFormModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: AccountRead | null
  onClose: () => void
  onSaved: (a: AccountRead, action: 'created' | 'updated') => void
}) {
  const isEdit = initial !== null
  const [name, setName] = useState(initial?.name ?? '')
  const [billingEmail, setBillingEmail] = useState(initial?.billing_email ?? '')
  const [billingAddress, setBillingAddress] = useState(
    initial?.billing_address ?? '',
  )
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      if (isEdit && initial) {
        const payload: AccountUpdate = {
          name: name.trim() !== initial.name ? name.trim() : undefined,
          billing_email: billingEmail.trim() || null,
          billing_address: billingAddress.trim() || null,
          notes: notes.trim() || null,
        }
        const saved = await api.updateAccount(initial.id, payload)
        onSaved(saved, 'updated')
      } else {
        const payload: AccountCreate = {
          name: name.trim(),
          billing_email: billingEmail.trim() || null,
          billing_address: billingAddress.trim() || null,
          notes: notes.trim() || null,
        }
        const saved = await api.createAccount(payload)
        onSaved(saved, 'created')
      }
    } catch (e: unknown) {
      setError(String((e as { detail?: string })?.detail ?? e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalShell
      title={isEdit ? `Edit account` : 'New account'}
      subtitle={isEdit ? initial!.name : 'Billing entity'}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        <div>
          <Label>Account name *</Label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. TQL"
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
            required
            autoFocus
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>Billing email</Label>
            <input
              type="email"
              value={billingEmail}
              onChange={(e) => setBillingEmail(e.target.value)}
              placeholder="ap@tql.com"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
            />
          </div>
          <div>
            <Label>Billing address</Label>
            <input
              type="text"
              value={billingAddress}
              onChange={(e) => setBillingAddress(e.target.value)}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
            />
          </div>
        </div>
        <div>
          <Label>Notes</Label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
          />
        </div>
        <FormFooter
          onClose={onClose}
          submitting={submitting}
          submitLabel={isEdit ? 'Save changes' : 'Create account'}
        />
      </form>
    </ModalShell>
  )
}

// ─── Brand (Customer) form modal ──────────────────────────────────────

function BrandFormModal({
  initial,
  accounts,
  onClose,
  onSaved,
}: {
  initial: CustomerRead | null
  accounts: AccountRead[]
  onClose: () => void
  onSaved: (c: CustomerRead, action: 'created' | 'updated') => void
}) {
  const isEdit = initial !== null
  const [name, setName] = useState(initial?.name ?? '')
  const [accountId, setAccountId] = useState<number | ''>(
    initial?.account_id ?? '',
  )
  const [contactEmail, setContactEmail] = useState(initial?.contact_email ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const accountIdValue = accountId === '' ? null : Number(accountId)
      if (isEdit && initial) {
        const saved = await api.updateCustomer(initial.id, {
          name: name.trim() !== initial.name ? name.trim() : undefined,
          account_id: accountIdValue,
          contact_email: contactEmail.trim() || null,
        })
        onSaved(saved, 'updated')
      } else {
        const saved = await api.createCustomer({
          name: name.trim(),
          account_id: accountIdValue,
          contact_email: contactEmail.trim() || null,
        })
        onSaved(saved, 'created')
      }
    } catch (e: unknown) {
      setError(String((e as { detail?: string })?.detail ?? e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalShell
      title={isEdit ? 'Edit brand' : 'New brand'}
      subtitle={isEdit ? initial!.name : 'Product owner'}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        <div>
          <Label>Brand name *</Label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Lime"
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
            required
            autoFocus
          />
        </div>
        <div>
          <Label>Account (billed to)</Label>
          <select
            value={accountId}
            onChange={(e) =>
              setAccountId(e.target.value ? Number(e.target.value) : '')
            }
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
          >
            <option value="">— direct bill (no parent account) —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-slate-500 mt-1">
            We bill the account, not the brand. Lime → TQL means TQL is invoiced
            for Lime's warehouse activity.
          </p>
        </div>
        <div>
          <Label>Contact email</Label>
          <input
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:border-[#0093D0] focus:ring-2 focus:ring-[#0093D0]/20 focus:outline-none"
          />
        </div>
        <FormFooter
          onClose={onClose}
          submitting={submitting}
          submitLabel={isEdit ? 'Save changes' : 'Create brand'}
        />
      </form>
    </ModalShell>
  )
}

// ─── Shared bits ──────────────────────────────────────────────────────

function ModalShell({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string
  subtitle: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl w-full max-w-xl mt-12">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-[#0093D0]">
              {title}
            </div>
            <h3 className="text-lg font-bold text-[#1B4676] mt-0.5">{subtitle}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 text-xl px-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function FormFooter({
  onClose,
  submitting,
  submitLabel,
}: {
  onClose: () => void
  submitting: boolean
  submitLabel: string
}) {
  return (
    <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
      <button
        type="button"
        onClick={onClose}
        className="text-sm font-medium text-slate-600 hover:text-slate-900 px-4 py-2"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={submitting}
        className="bg-[#0093D0] hover:bg-[#00A8E8] disabled:bg-slate-300 text-white text-sm font-semibold rounded-full px-5 py-2 shadow-[0_6px_18px_-4px_rgba(0,147,208,0.4)]"
      >
        {submitting ? 'Saving…' : submitLabel}
      </button>
    </div>
  )
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5"
      style={{
        boxShadow:
          '0 1px 2px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.08)',
      }}
    >
      {children}
    </div>
  )
}

function Label({ children }: { children: ReactNode }) {
  return (
    <label className="block text-[10.5px] uppercase tracking-[0.15em] font-bold text-slate-500 mb-1">
      {children}
    </label>
  )
}

function Th({
  children,
  align = 'left',
}: {
  children: ReactNode
  align?: 'left' | 'right' | 'center'
}) {
  return (
    <th
      className={`px-3 py-2 font-semibold tracking-wider text-${align} whitespace-nowrap`}
    >
      {children}
    </th>
  )
}

function LoadingHint() {
  return (
    <div className="mt-4 text-sm text-slate-500 flex items-center gap-2">
      <span
        className="inline-block w-2 h-2 rounded-full bg-[#0093D0] animate-pulse"
        aria-hidden
      />
      <span>Loading…</span>
    </div>
  )
}
