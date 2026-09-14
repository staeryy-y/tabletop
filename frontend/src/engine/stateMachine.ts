/** Explicit state machine for pointer gestures. Illegal overlapping gestures are
 * rejected at the transition boundary instead of being represented by nullable fields
 * that can conflict. */
export enum GestureState {
  Idle = "idle",
  CardDrag = "card-drag",
  PileDrag = "pile-drag",
  PieceDrag = "piece-drag",
  MatDrag = "mat-drag",
  GroupDrag = "group-drag",
  Rotate = "rotate",
  BoxSelect = "box-select",
}

export class GestureStateMachine {
  private state = GestureState.Idle;

  get current(): GestureState { return this.state; }
  isIdle(): boolean { return this.state === GestureState.Idle; }

  begin(next: Exclude<GestureState, GestureState.Idle>): boolean {
    if (!this.isIdle()) return false;
    this.state = next;
    return true;
  }

  end(expected?: Exclude<GestureState, GestureState.Idle>): void {
    if (expected !== undefined && this.state !== expected) return;
    this.state = GestureState.Idle;
  }
}
