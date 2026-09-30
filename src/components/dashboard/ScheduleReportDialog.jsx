import React, {useState} from 'react';
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription} from '@/components/ui/dialog';
export default function ScheduleReportDialog({isOpen,onClose,onSendTest}) {
  const [busy,setBusy] = useState(false);
  return <Dialog open={isOpen} onOpenChange={open => {if (!open) onClose();}}><DialogContent>
    <DialogHeader><DialogTitle>Report delivery unavailable</DialogTitle><DialogDescription>Automated email delivery is not configured. You can download the owner packet for the current selection.</DialogDescription></DialogHeader>
    <button type="button" disabled={busy || !onSendTest} onClick={async()=>{setBusy(true);try {await onSendTest?.();} finally {setBusy(false);}}} className="rounded-lg bg-indigo-600 px-4 py-2 text-white disabled:opacity-50">{busy?'Generating?':'Download owner packet'}</button>
  </DialogContent></Dialog>;
}
