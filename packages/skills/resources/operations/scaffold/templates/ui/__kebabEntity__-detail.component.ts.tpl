/* Generated for __NAMESPACE__/__MODULE__ — spec: __SPEC_VERSION__ sha: __SPEC_SHA__ */
import { Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { __classEntity__Service } from './__kebabEntity__.service';

@Component({
  selector: '__kebabModule__-__kebabEntity__-detail',
  template: `
    <ng-container *ngIf="item; else loading">
      <h2>__classEntity__ {{ item.id }}</h2>
      <pre>{{ item | json }}</pre>
    </ng-container>
    <ng-template #loading>Loading…</ng-template>
  `,
})
export class __classEntity__DetailComponent implements OnInit {
  item: any;
  constructor(private readonly svc: __classEntity__Service, private readonly route: ActivatedRoute) {}
  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id')!;
    this.svc.get(id).subscribe((res) => (this.item = res));
  }
}

