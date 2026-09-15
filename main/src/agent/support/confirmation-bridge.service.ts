import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';

export interface ConfirmFormField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  default?: any;
  columns?: { key: string; label: string }[];
}

export interface ConfirmRequest {
  confirmId: string;
  toolName: string;
  args: Record<string, any>;
  parameters: { name: string; type: string; required?: boolean; description?: string; label?: string }[];
  confirmForm?: ConfirmFormField[];
  description?: string;
}

@Injectable()
export class ConfirmationBridgeService {
  private readonly logger = new Logger(ConfirmationBridgeService.name);
  private pending = new Map<string, { resolve: (args: any) => void; reject: (err: Error) => void }>();
  /** Gateway listens on this emitter for 'confirm_request' events */
  readonly events = new EventEmitter();

  /**
   * Request user confirmation for tool args.
   * Emits 'confirm_request' on this.events and returns a Promise that resolves
   * when the user confirms (with possibly edited args) or rejects on cancel/timeout.
   */
  requestConfirmation(request: ConfirmRequest): Promise<Record<string, any>> {
    this.logger.log(`Requesting confirmation: ${request.confirmId} for tool ${request.toolName}`);
    this.events.emit('confirm_request', request);

    return new Promise((resolve, reject) => {
      this.pending.set(request.confirmId, { resolve, reject });
    });
  }

  /**
   * Handle user's reply to a confirmation request.
   * Returns true if the confirmId was found and handled.
   */
  handleReply(confirmId: string, confirmed: boolean, editedArgs?: Record<string, any>): boolean {
    const entry = this.pending.get(confirmId);
    if (!entry) {
      this.logger.warn(`No pending confirmation for: ${confirmId}`);
      return false;
    }
    this.pending.delete(confirmId);
    if (confirmed) {
      this.logger.log(`Confirmed: ${confirmId}`);
      entry.resolve(editedArgs || {});
    } else {
      this.logger.log(`Cancelled: ${confirmId}`);
      entry.reject(new Error('user_cancelled'));
    }
    return true;
  }
}
