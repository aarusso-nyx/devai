/* Generated for __NAMESPACE__/__MODULE__ — spec: __SPEC_VERSION__ sha: __SPEC_SHA__ */
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { __classEntity__Service } from './__kebabEntity__.service';

describe('__classEntity__Service', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HttpClientTestingModule], providers: [__classEntity__Service] });
  });
  it('creates', () => {
    const svc = TestBed.inject(__classEntity__Service);
    expect(svc).toBeTruthy();
  });
});

