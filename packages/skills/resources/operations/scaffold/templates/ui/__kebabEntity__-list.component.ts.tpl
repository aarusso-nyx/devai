/* Generated for __NAMESPACE__/__MODULE__ — spec: __SPEC_VERSION__ sha: __SPEC_SHA__ */
import { Component, OnInit } from '@angular/core';
import { __classEntity__Service } from './__kebabEntity__.service';

@Component({
  selector: '__kebabModule__-__kebabEntity__-list',
  template: `
    <h2>__classEntity__s</h2>
    <ul>
      <li *ngFor="let item of items">{{ item.message }} → {{ item.recipient || '—' }}</li>
    </ul>
  `,
})
export class __classEntity__ListComponent implements OnInit {
  items: any[] = [];
  constructor(private readonly svc: __classEntity__Service) {}
  ngOnInit(): void {
    this.svc.list().subscribe((res) => (this.items = res));
  }
}

