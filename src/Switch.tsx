import type { RefObject } from 'react';

export function Switch({ checked, labelledBy, describedBy, onChange, disabled = false, tabIndex, buttonRef }: {
  checked: boolean; labelledBy: string; describedBy?: string; onChange: (checked: boolean) => void;
  disabled?: boolean; tabIndex?: number; buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return <button className="control-switch" ref={buttonRef} type="button" role="switch" tabIndex={tabIndex} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span></button>;
}
