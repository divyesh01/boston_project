import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
        return (_jsxs(RadixSelect, { value: value || undefined, onValueChange: onValueChange, disabled: disabled, children: [_jsx(SelectTrigger, { className: "h-9 w-full rounded-lg border-white/10 bg-[#0A1628] text-sm text-slate-200", children: _jsx(SelectValue, { placeholder: placeholder || "Select…" }) }), _jsx(SelectContent, { className: "max-h-60 bg-[#0F1F35]", children: options.map((o) => (_jsx(SelectItem, { value: o[0], children: o[1] }, o[0]))) })] }));
    }
    const selectedLabel = options.find((o) => o[0] === value)?.[1] || placeholder || "Select…";
    return (_jsxs(_Fragment, { children: [_jsxs("button", { type: "button", disabled: disabled, onClick: () => setOpen(true), className: "flex h-11 w-full items-center justify-between rounded-lg border border-white/10 bg-[#0A1628] px-3 text-sm text-slate-200 disabled:opacity-50", children: [_jsx("span", { className: "truncate", children: selectedLabel }), _jsx(ChevronDown, { className: "ml-2 h-4 w-4 shrink-0 text-slate-500" })] }), _jsx(Drawer, { open: open, onOpenChange: setOpen, children: _jsx(DrawerContent, { className: "bg-[#0F1F35]", style: { paddingBottom: "env(safe-area-inset-bottom)" }, children: _jsxs("div", { className: "mx-auto w-full max-w-md p-4", children: [label && _jsx("p", { className: "mb-2 text-xs uppercase tracking-widest text-slate-500", children: label }), _jsx("div", { className: "max-h-[50vh] overflow-auto pb-4", children: options.map((o) => (_jsxs("button", { onClick: () => {
                                        onValueChange(o[0]);
                                        setOpen(false);
                                    }, disabled: o[2]?.disabled, className: "flex min-h-[44px] w-full items-center justify-between rounded-lg px-4 py-3 text-left text-sm text-slate-200 transition-colors hover:bg-white/5 disabled:opacity-40", children: [o[1], o[0] === value && _jsx(Check, { className: "h-4 w-4 text-[#00D4FF]" })] }, o[0]))) })] }) }) })] }));
}
