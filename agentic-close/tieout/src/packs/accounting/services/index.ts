/** The accounting pack's service facade: one object per unit of work, passed to tools and use cases. */
import type { Actor } from '../../../core/agent/types';
import type { Clock } from '../../../core/util/time';
import type { DbTx } from '../../../schema';
import { AccrualService } from './accruals';
import { AnomalyService } from './anomaly';
import { BankService } from './bank';
import { CloseService } from './close';
import { CodingService } from './coding';
import { AcctContext } from './context';
import { FluxService } from './flux';
import { IntercompanyService } from './intercompany';
import { ScheduleService } from './schedules';
import { SubledgerService } from './subledgers';

export class AccountingServices {
  readonly ctx: AcctContext;
  readonly bank: BankService;
  readonly coding: CodingService;
  readonly subledgers: SubledgerService;
  readonly accruals: AccrualService;
  readonly schedules: ScheduleService;
  readonly intercompany: IntercompanyService;
  readonly flux: FluxService;
  readonly anomaly: AnomalyService;
  readonly close: CloseService;

  constructor(tx: DbTx, actor: Actor, clock: Clock) {
    this.ctx = new AcctContext(tx, actor, clock);
    this.bank = new BankService(this.ctx);
    this.coding = new CodingService(this.ctx);
    this.subledgers = new SubledgerService(this.ctx);
    this.accruals = new AccrualService(this.ctx);
    this.schedules = new ScheduleService(this.ctx);
    this.intercompany = new IntercompanyService(this.ctx);
    this.flux = new FluxService(this.ctx);
    this.anomaly = new AnomalyService(this.ctx);
    this.close = new CloseService(this.ctx);
  }

  get tx() {
    return this.ctx.tx;
  }
}

export { AcctContext };
