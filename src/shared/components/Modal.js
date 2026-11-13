"use client";

import { Modal as AntModal } from "antd";
import { cn } from "@/shared/utils/cn";
import Button from "./Button";

const SIZE_WIDTHS = {
  sm: 400,
  md: 480,
  lg: 560,
  xl: 640,
  full: 896,
};

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = "md",
  closeOnOverlay = true,
  className,
}) {
  return (
    <AntModal
      open={Boolean(isOpen)}
      onCancel={onClose}
      title={title ? <span className="text-base font-semibold tracking-tight">{title}</span> : null}
      footer={footer ?? null}
      width={SIZE_WIDTHS[size] || SIZE_WIDTHS.md}
      mask={{ closable: closeOnOverlay, blur: true }}
      destroyOnHidden
      centered
      className={cn("hyperion-modal", className)}
    >
      <div className="max-h-[calc(85vh-120px)] overflow-y-auto custom-scrollbar pt-2">
        {children}
      </div>
    </AntModal>
  );
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title = "Confirm",
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "danger",
  loading = false,
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelText}
          </Button>
          <Button variant={variant} onClick={onConfirm} loading={loading}>
            {confirmText}
          </Button>
        </div>
      }
    >
      <p className="text-text-muted text-sm">{message}</p>
    </Modal>
  );
}
