import { useState } from 'react';
import { motion } from 'framer-motion';
import { BadgePercent, Crown, Info, Plus, Trash2, Users } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useSubscriptionStore, type Coupon } from '@/store/useSubscriptionStore';
import { useAdminStore } from '@/store/useAdminStore';
import { useBackupStore } from '@/store/useBackupStore';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('es-ES');
  } catch {
    return iso;
  }
}

/**
 * Suscripciones, usuarios premium y cupones — gestión preparada para el
 * futuro. La facturación real aún no está activada y así se indica en la
 * interfaz (sin simular cobros ni estados inexistentes).
 */
export function SubscriptionManager() {
  const coupons = useSubscriptionStore((s) => s.coupons);
  const premiumUsers = useSubscriptionStore((s) => s.premiumUsers);
  const plans = useSubscriptionStore((s) => s.plans);
  const createCoupon = useSubscriptionStore((s) => s.createCoupon);
  const toggleCoupon = useSubscriptionStore((s) => s.toggleCoupon);
  const deleteCoupon = useSubscriptionStore((s) => s.deleteCoupon);
  const grantPremium = useSubscriptionStore((s) => s.grantPremium);
  const revokePremium = useSubscriptionStore((s) => s.revokePremium);
  const updatePlan = useSubscriptionStore((s) => s.updatePlan);
  const addAuditLog = useAdminStore((s) => s.addAuditLog);
  const adminEmail = useAdminStore((s) => s.adminEmail);
  const autoBackup = useBackupStore((s) => s.autoBackup);

  const [code, setCode] = useState('');
  const [percent, setPercent] = useState(10);
  const [maxUses, setMaxUses] = useState(100);
  const [expiresAt, setExpiresAt] = useState('');
  const [couponError, setCouponError] = useState('');

  const [premiumEmail, setPremiumEmail] = useState('');
  const [premiumPlan, setPremiumPlan] = useState('pro');
  const [premiumError, setPremiumError] = useState('');
  const [premiumNotice, setPremiumNotice] = useState('');

  const [deletingCoupon, setDeletingCoupon] = useState<Coupon | null>(null);
  const [revokingPremium, setRevokingPremium] = useState<string | null>(null);

  const audit = (action: string, details: string) => {
    addAuditLog({
      userId: 'admin_master',
      userEmail: adminEmail ?? 'admin',
      action,
      details,
      type: 'admin',
    });
  };

  const handleCreateCoupon = (e: React.FormEvent) => {
    e.preventDefault();
    setCouponError('');
    const result = createCoupon({
      code,
      percentOff: Number(percent),
      maxUses: Number(maxUses),
      expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
    });
    if (!result.ok) {
      setCouponError(result.reason ?? 'No se pudo crear el cupón');
      return;
    }
    audit('Cupón creado', `Cupón ${code.trim().toUpperCase()} (${percent}% dto., ${maxUses} usos)`);
    setCode('');
  };

  const handleToggleCoupon = (c: Coupon) => {
    toggleCoupon(c.id);
    audit('Cupón actualizado', `Cupón ${c.code} ${c.active ? 'desactivado' : 'activado'}`);
  };

  const handleDeleteCoupon = () => {
    if (!deletingCoupon) return false;
    autoBackup('Antes de eliminar un cupón');
    deleteCoupon(deletingCoupon.id);
    audit('Cupón eliminado', `Cupón ${deletingCoupon.code} eliminado (con copia previa)`);
    setDeletingCoupon(null);
    return true;
  };

  const handleGrantPremium = (e: React.FormEvent) => {
    e.preventDefault();
    setPremiumError('');
    setPremiumNotice('');
    const result = grantPremium(premiumEmail, premiumPlan);
    if (!result.ok) {
      setPremiumError(result.reason ?? 'No se pudo conceder premium');
      return;
    }
    audit('Premium concedido', `${premiumEmail.trim().toLowerCase()} → plan ${premiumPlan}`);
    setPremiumNotice('Usuario premium añadido.');
    setPremiumEmail('');
  };

  const handleRevokePremium = () => {
    if (!revokingPremium) return false;
    const target = premiumUsers.find((p) => p.id === revokingPremium);
    revokePremium(revokingPremium);
    if (target) audit('Premium retirado', `Se retiró el premium a ${target.email}`);
    setRevokingPremium(null);
    return true;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      {/* Aviso honesto del estado de la función */}
      <div className="p-4 rounded-xl bg-ixi-cyan/5 border border-ixi-cyan/25 flex items-start gap-3">
        <Info className="w-4 h-4 text-ixi-cyan mt-0.5 flex-shrink-0" />
        <p className="text-xs text-ixi-textMuted leading-relaxed">
          Gestión <strong className="text-ixi-text">preparada para el futuro</strong>: cupones,
          usuarios premium y planes se gestionan aquí, pero la facturación real aún no está
          activada en ixi 4k. Ningún cobro se procesa ni se simula.
        </p>
      </div>

      {/* Planes */}
      <div className="card p-4 sm:p-6">
        <h3 className="font-semibold flex items-center gap-2 mb-4">
          <Crown className="w-5 h-5 text-ixi-warning" />
          Planes
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {plans.map((plan) => (
            <div
              key={plan.id}
              className="p-4 rounded-xl bg-ixi-bgSecondary/50 border border-white/10"
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <input
                  value={plan.name}
                  onChange={(e) => updatePlan(plan.id, { name: e.target.value })}
                  className="bg-transparent font-semibold text-ixi-text w-full min-w-0"
                  aria-label={`Nombre del plan ${plan.id}`}
                />
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase flex-shrink-0 ${
                    plan.status === 'disponible'
                      ? 'bg-ixi-success/10 text-ixi-success'
                      : 'bg-ixi-warning/10 text-ixi-warning'
                  }`}
                >
                  {plan.status === 'disponible' ? 'Disponible' : 'Pendiente'}
                </span>
              </div>
              <input
                value={plan.price}
                onChange={(e) => updatePlan(plan.id, { price: e.target.value })}
                className="input-field mb-2 text-sm"
                placeholder="Precio (p. ej. 4,99 €/mes)"
                aria-label={`Precio del plan ${plan.name}`}
              />
              <ul className="space-y-1">
                {plan.features.map((f) => (
                  <li key={f} className="text-xs text-ixi-textMuted">
                    • {f}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() =>
                  updatePlan(plan.id, {
                    status: plan.status === 'disponible' ? 'pendiente' : 'disponible',
                  })
                }
                className="mt-3 text-[11px] text-ixi-cyan hover:underline"
              >
                {plan.status === 'disponible' ? 'Marcar como pendiente' : 'Marcar disponible'}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Cupones */}
      <div className="card p-4 sm:p-6">
        <h3 className="font-semibold flex items-center gap-2 mb-4">
          <BadgePercent className="w-5 h-5 text-ixi-violet" />
          Cupones
        </h3>

        <form onSubmit={handleCreateCoupon} className="space-y-3 mb-4">
          {couponError && (
            <p className="text-xs text-ixi-danger" role="alert">
              {couponError}
            </p>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              className="input-field font-mono"
              placeholder="CÓDIGO"
              aria-label="Código del cupón"
            />
            <input
              type="number"
              min={1}
              max={100}
              value={percent}
              onChange={(e) => setPercent(Number(e.target.value))}
              className="input-field"
              placeholder="% descuento"
              aria-label="Porcentaje de descuento"
            />
            <input
              type="number"
              min={1}
              value={maxUses}
              onChange={(e) => setMaxUses(Number(e.target.value))}
              className="input-field"
              placeholder="Usos máx."
              aria-label="Usos máximos"
            />
            <input
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="input-field"
              aria-label="Caducidad"
            />
          </div>
          <button
            type="submit"
            disabled={!code.trim()}
            className="btn-primary px-4 py-2 text-sm disabled:opacity-50 flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> Crear cupón
          </button>
        </form>

        {coupons.length === 0 ? (
          <p className="text-sm text-ixi-textMuted">Sin cupones creados.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-white/10 text-xs text-ixi-textMuted">
                  <th className="text-left p-2">Código</th>
                  <th className="text-left p-2">Dto.</th>
                  <th className="text-left p-2">Usos</th>
                  <th className="text-left p-2">Caduca</th>
                  <th className="text-left p-2">Estado</th>
                  <th className="text-right p-2">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((c) => (
                  <tr key={c.id} className="border-b border-white/10">
                    <td className="p-2 font-mono text-ixi-cyan">{c.code}</td>
                    <td className="p-2">{c.percentOff}%</td>
                    <td className="p-2">
                      {c.uses}/{c.maxUses}
                    </td>
                    <td className="p-2 text-xs text-ixi-textMuted">{formatDate(c.expiresAt)}</td>
                    <td className="p-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                          c.active ? 'bg-ixi-success/10 text-ixi-success' : 'bg-ixi-bgCard text-ixi-textMuted'
                        }`}
                      >
                        {c.active ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td className="p-2">
                      <div className="flex items-center gap-1.5 justify-end">
                        <button
                          type="button"
                          onClick={() => handleToggleCoupon(c)}
                          className="px-2 py-1 rounded-lg bg-ixi-bgCard border border-ixi-border text-[11px] text-ixi-textMuted hover:text-ixi-cyan transition-colors"
                        >
                          {c.active ? 'Desactivar' : 'Activar'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletingCoupon(c)}
                          className="p-1.5 rounded-lg bg-ixi-danger/10 text-ixi-danger hover:bg-ixi-danger/20 transition-colors"
                          title="Eliminar cupón"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Usuarios premium */}
      <div className="card p-4 sm:p-6">
        <h3 className="font-semibold flex items-center gap-2 mb-4">
          <Users className="w-5 h-5 text-ixi-warning" />
          Usuarios Premium
        </h3>

        <form onSubmit={handleGrantPremium} className="space-y-3 mb-4">
          {premiumError && (
            <p className="text-xs text-ixi-danger" role="alert">
              {premiumError}
            </p>
          )}
          {premiumNotice && (
            <p className="text-xs text-ixi-success" role="status">
              {premiumNotice}
            </p>
          )}
          <div className="flex gap-2 flex-col sm:flex-row">
            <input
              type="email"
              value={premiumEmail}
              onChange={(e) => setPremiumEmail(e.target.value)}
              className="input-field flex-1"
              placeholder="usuario@email.com"
              aria-label="Correo del usuario premium"
            />
            <select
              value={premiumPlan}
              onChange={(e) => setPremiumPlan(e.target.value)}
              className="input-field"
              aria-label="Plan premium"
            >
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={!premiumEmail.trim()}
              className="btn-primary px-4 py-2 text-sm disabled:opacity-50"
            >
              Conceder
            </button>
          </div>
        </form>

        {premiumUsers.length === 0 ? (
          <p className="text-sm text-ixi-textMuted">Ningún usuario premium concedido todavía.</p>
        ) : (
          <div className="space-y-2">
            {premiumUsers.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-3 p-3 rounded-xl bg-ixi-bgSecondary/40 border border-white/10"
              >
                <div className="min-w-0">
                  <p className="text-sm text-ixi-text truncate">{p.email}</p>
                  <p className="text-[11px] text-ixi-textMuted">
                    Plan {p.plan} · desde {formatDate(p.since)} ·{' '}
                    <span className={p.active ? 'text-ixi-success' : 'text-ixi-textMuted'}>
                      {p.active ? 'activo' : 'inactivo'}
                    </span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setRevokingPremium(p.id)}
                  className="px-3 py-1.5 rounded-lg bg-ixi-danger/10 text-ixi-danger text-xs font-medium hover:bg-ixi-danger/20 transition-colors flex-shrink-0"
                >
                  Quitar
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deletingCoupon}
        title="Eliminar cupón"
        message={`Se eliminará el cupón ${deletingCoupon?.code}. Se guardará una copia de seguridad automática antes.`}
        confirmLabel="Eliminar"
        danger
        onCancel={() => setDeletingCoupon(null)}
        onConfirm={handleDeleteCoupon}
      />

      <ConfirmDialog
        open={!!revokingPremium}
        title="Quitar premium"
        message="Se retirará el estado premium de este usuario. Podrás concederlo de nuevo cuando quieras."
        confirmLabel="Quitar premium"
        danger
        onCancel={() => setRevokingPremium(null)}
        onConfirm={handleRevokePremium}
      />
    </motion.div>
  );
}
