import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useEffect, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, CheckCircle, AlertTriangle, Copy, QrCode, Download } from "lucide-react";
import QRCode from "qrcode";
import { toast } from "@/components/ui/use-toast";
export default function MFASetup({ secret, uri, userEmail, onComplete, onCancel, backupCodes = [], isEnabling = true }) {
    const [currentStep, setCurrentStep] = useState(1);
    const [totpToken, setTotpToken] = useState("");
    const [verifying, setVerifying] = useState(false);
    const [copiedIndex, setCopiedIndex] = useState(-1);
    const [showBackupCodes, setShowBackupCodes] = useState(false);
    const [savedBackupCodes, setSavedBackupCodes] = useState(false);
    const qrCanvasRef = useRef(/** @type {HTMLCanvasElement | null} */ (null));
    const backupCodesRef = useRef(backupCodes);
    useEffect(() => {
        backupCodesRef.current = backupCodes;
    }, [backupCodes]);
    useEffect(() => {
        if (qrCanvasRef.current && uri) {
            QRCode.toCanvas(qrCanvasRef.current, uri, {
                width: 200,
                margin: 2,
                color: { dark: '#000000', light: '#ffffff' }
            }).catch(console.error);
        }
    }, [uri]);
    const generateBackupCodes = () => {
        const codes = [];
        for (let i = 0; i < 10; i++) {
            const code = Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
            codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
        }
        return codes;
    };
    const handleVerify = async () => {
        if (!totpToken || totpToken.length !== 6) {
            toast({ variant: "destructive", title: "Error", description: "Please enter a 6-digit code." });
            return;
        }
        setVerifying(true);
        try {
            await onComplete(totpToken);
            toast({ title: "MFA enabled successfully!", description: "Your account is now protected with two-factor authentication." });
        }
        catch (e) {
            toast({ variant: "destructive", title: "Invalid code", description: e.message || "The code is incorrect or has expired." });
        }
        finally {
            setVerifying(false);
        }
    };
    const copyCode = async (index, code) => {
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
            toast({ title: "Copy failed", description: "Clipboard not available in this browser." });
            return;
        }
        await navigator.clipboard.writeText(code.replace('-', ''));
        setCopiedIndex(index);
        setTimeout(() => setCopiedIndex(-1), 2000);
        toast({ title: "Copied!", description: "Backup code copied to clipboard." });
    };
    const copyAllCodes = async () => {
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
            toast({ title: "Copy failed", description: "Clipboard not available in this browser." });
            return;
        }
        const allCodes = backupCodesRef.current.map(c => c.replace('-', '')).join('\n');
        await navigator.clipboard.writeText(allCodes);
        toast({ title: "All codes copied", description: "10 backup codes copied to clipboard." });
    };
    const downloadCodes = () => {
        const content = `Red Roof Intelligence - MFA Backup Codes\nUser: ${userEmail}\nGenerated: ${new Date().toISOString()}\n\n${backupCodesRef.current.map(c => c.replace('-', '')).join('\n')}\n\nIMPORTANT: Store these codes securely. Each code can only be used once.`;
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mfa-backup-codes-${userEmail.replace('@', '-at-')}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        toast({ title: "Downloaded", description: "Backup codes saved to file." });
    };
    const markSaved = () => {
        setSavedBackupCodes(true);
        setShowBackupCodes(false);
        setCurrentStep(3);
    };
    if (currentStep === 1) {
        return (_jsx("div", { className: "space-y-6 max-w-md mx-auto", children: _jsxs(Card, { children: [_jsxs(CardHeader, { className: "text-center", children: [_jsx(QrCode, { className: "mx-auto h-10 w-10 text-[#6C63FF]" }), _jsx(CardTitle, { className: "mt-2", children: "Set up Authenticator App" }), _jsx(CardDescription, { children: "Scan the QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.)" })] }), _jsxs(CardContent, { className: "space-y-6", children: [_jsx("div", { className: "flex justify-center", children: _jsx("div", { className: "bg-white p-4 rounded-lg border", children: _jsx("canvas", { ref: qrCanvasRef, className: "mx-auto" }) }) }), _jsxs("div", { className: "space-y-3 text-sm", children: [_jsx("div", { className: "font-mono text-xs text-muted-foreground break-all bg-slate-100 dark:bg-slate-800 p-2 rounded", children: secret }), _jsxs("p", { className: "text-center text-muted-foreground", children: ["Or enter this secret key manually: ", _jsx("strong", { children: secret })] })] }), _jsx(Alert, { className: "border-amber-500/30 bg-amber-500/10", children: _jsxs(AlertDescription, { className: "text-sm flex items-center gap-2", children: [_jsx(AlertTriangle, { className: "h-4 w-4 flex-shrink-0" }), _jsx("strong", { children: "Save backup codes!" }), " You'll receive 10 one-time backup codes after verification. Store them securely \u2014 each can only be used once."] }) }), _jsxs("div", { className: "space-y-3", children: [_jsx(Label, { children: "Enter the 6-digit code from your app" }), _jsx("div", { className: "relative", children: _jsx(Input, { type: "text", inputMode: "numeric", pattern: "[0-9]*", maxLength: 6, placeholder: "000000", value: totpToken, onChange: (e) => setTotpToken(e.target.value.replace(/\D/g, '').slice(0, 6)), className: "text-2xl tracking-widest text-center h-14", autoFocus: true, autoComplete: "one-time-code" }) }), _jsx(Button, { className: "w-full h-12 text-lg", onClick: handleVerify, disabled: verifying || totpToken.length !== 6, children: verifying ? (_jsxs(_Fragment, { children: [_jsx(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }), "Verifying..."] })) : ("Verify & Continue") })] }), _jsx(Button, { variant: "outline", className: "w-full", onClick: onCancel, children: "Cancel" })] })] }) }));
    }
    if (currentStep === 2) {
        const codes = backupCodesRef.current.length > 0 ? backupCodesRef.current : generateBackupCodes();
        return (_jsx("div", { className: "space-y-6 max-w-md mx-auto", children: _jsxs(Card, { children: [_jsxs(CardHeader, { className: "text-center", children: [_jsx(CheckCircle, { className: "mx-auto h-10 w-10 text-emerald-500" }), _jsx(CardTitle, { className: "mt-2", children: "MFA Enabled Successfully!" }), _jsx(CardDescription, { children: "Your account is now protected with two-factor authentication." })] }), _jsxs(CardContent, { className: "space-y-6", children: [_jsx(Alert, { className: "border-red-500/30 bg-red-500/10", children: _jsxs(AlertDescription, { className: "text-sm flex items-center gap-2", children: [_jsx(AlertTriangle, { className: "h-4 w-4 flex-shrink-0" }), _jsx("strong", { children: "Critical:" }), " Save your backup codes now. They will not be shown again."] }) }), _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx(Label, { className: "mb-0", children: "Backup Codes (10 one-time use)" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs(Button, { variant: "outline", size: "sm", onClick: copyAllCodes, children: [_jsx(Copy, { className: "mr-1 h-3 w-3" }), " Copy All"] }), _jsxs(Button, { variant: "outline", size: "sm", onClick: downloadCodes, children: [_jsx(Download, { className: "mr-1 h-3 w-3" }), " Download"] })] })] }), _jsx("div", { className: "grid grid-cols-2 gap-2", children: codes.map((code, index) => (_jsx("button", { type: "button", onClick: () => copyCode(index, code), className: `relative p-3 text-center font-mono text-sm bg-slate-50 dark:bg-slate-800 rounded-lg border transition-all ${copiedIndex === index ? 'bg-emerald-100 border-emerald-500' : 'hover:bg-slate-100'}`, "aria-label": `Backup code ${index + 1}: ${code}. Click to copy.`, children: _jsx("span", { className: copiedIndex === index ? 'text-emerald-600' : '', children: copiedIndex === index ? (_jsx(CheckCircle, { className: "mx-auto h-4 w-4" })) : (code) }) }, index))) }), _jsx("p", { className: "text-xs text-muted-foreground text-center", children: "Click any code to copy it. Each code works once. Keep these safe!" })] }), _jsxs("div", { className: "flex items-center gap-3 p-4 bg-slate-50 dark:bg-slate-800 rounded-lg", children: [_jsx(Checkbox, { id: "saved-codes", checked: savedBackupCodes, onCheckedChange: markSaved }), _jsx(Label, { htmlFor: "saved-codes", className: "text-sm font-medium", children: "I have saved my backup codes securely" })] }), _jsx(Button, { className: "w-full h-12", onClick: markSaved, disabled: !savedBackupCodes, children: "Done \u2014 Continue to Dashboard" })] })] }) }));
    }
    return (_jsx("div", { className: "space-y-6 max-w-md mx-auto text-center", children: _jsxs(Card, { children: [_jsxs(CardHeader, { children: [_jsx(CheckCircle, { className: "mx-auto h-10 w-10 text-emerald-500" }), _jsx(CardTitle, { className: "mt-2", children: "All Set!" }), _jsx(CardDescription, { children: "MFA is now active on your account." })] }), _jsxs(CardContent, { className: "space-y-4", children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "You'll need your authenticator app for future logins." }), _jsx(Button, { className: "w-full", onClick: () => onComplete(null, true), children: "Continue to Dashboard" })] })] }) }));
}
