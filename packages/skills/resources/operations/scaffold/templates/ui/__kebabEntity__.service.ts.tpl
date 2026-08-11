/* Generated for __NAMESPACE__/__MODULE__ — spec: __SPEC_VERSION__ sha: __SPEC_SHA__ */
import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';

@Injectable()
export class __classEntity__Service {
  private readonly base = '/api/__NAMESPACE__/__kebabModule__/__kebabEntity__';
  constructor(private readonly http: HttpClient) {}
  list() {
    return this.http.get<any[]>(this.base);
  }
  get(id: string) {
    return this.http.get<any>(`${this.base}/${id}`);
  }
  create(body: any) {
    return this.http.post<any>(this.base, body);
  }
  update(id: string, body: any) {
    return this.http.put<any>(`${this.base}/${id}`, body);
  }
  remove(id: string) {
    return this.http.delete(`${this.base}/${id}`);
  }
}

