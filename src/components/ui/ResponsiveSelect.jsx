import React, { useState } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { Select as RadixSelect, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { Check, ChevronDown } from "lucide-react";

export default function ResponsiveSelect(
  /** @type {{
   *   value?: string;
   *   onValueChange?: (v: string) => void;
   *   options?: Array<[string, string, { disabled?: boolean }?]>;
   *   label?: string;
   *   placeholder?: string;
   *   disabled?: boolean;
   * }} */
  { value, onValueChange, options, label, placeholder, disabled }) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  if (!isMobile) {
    return (
      <RadixSelect value={value || undefined} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger className="h-9 w-full rounded-lg border-white/10 bg-[#0A1628] text-sm text-slate-200">
          <SelectValue placeholder={placeholder || "Select…"} />
        </SelectTrigger>
        <SelectContent className="max-h-60 bg-[#0F1F35]">
          {options.map((o) => (
            <SelectItem key={o[0]} value={o[0]}>{o[1]}</SelectItem>
          ))}
        </SelectContent>
      </RadixSelect>
    );
  }

  const selectedLabel = options.find((o) => o[0] === value)?.[1] || placeholder || "Select…";

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="flex h-11 w-full items-center justify-between rounded-lg border border-white/10 bg-[#0A1628] px-3 text-sm text-slate-200 disabled:opacity-50"
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-slate-500" />
      </button>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent className="bg-[#0F1F35]" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          <div className="mx-auto w-full max-w-md p-4">
            {label && <p className="mb-2 text-xs uppercase tracking-widest text-slate-500">{label}</p>}
            <div className="max-h-[50vh] overflow-auto pb-4">
              {options.map((o) => (
                <button
                  key={o[0]}
                  onClick={() => {
                    onValueChange(o[0]);
                    setOpen(false);
                  }}
                  disabled={o[2]?.disabled}
                  className="flex min-h-[44px] w-full items-center justify-between rounded-lg px-4 py-3 text-left text-sm text-slate-200 transition-colors hover:bg-white/5 disabled:opacity-40"
                >
                  {o[1]}
                  {o[0] === value && <Check className="h-4 w-4 text-[#00D4FF]" />}
                </button>
              ))}
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}