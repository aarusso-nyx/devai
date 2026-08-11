/* Generated for __NAMESPACE__/__MODULE__ — spec: __SPEC_VERSION__ sha: __SPEC_SHA__ */
import { CommonModule } from '@angular/common';
import { HttpClientModule } from '@angular/common/http';
import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { __classEntity__ListComponent } from './__kebabEntity__-list.component';
import { __classEntity__DetailComponent } from './__kebabEntity__-detail.component';
import { __classEntity__Service } from './__kebabEntity__.service';
import { CognitoGuard } from './guards/cognito.guard';
import { __MODULE__PolicyGuard } from './policy.guard';

const routes: Routes = [
  {
    path: '',
    canActivate: [CognitoGuard],
    children: [
      { path: '', component: __classEntity__ListComponent, canActivate: [__MODULE__PolicyGuard], data: { resource: '__kebabEntity__', action: 'read' } },
      { path: ':id', component: __classEntity__DetailComponent, canActivate: [__MODULE__PolicyGuard], data: { resource: '__kebabEntity__', action: 'read' } },
    ],
  },
];

@NgModule({
  declarations: [__classEntity__ListComponent, __classEntity__DetailComponent],
  imports: [CommonModule, HttpClientModule, RouterModule.forChild(routes)],
  providers: [__classEntity__Service, CognitoGuard],
})
export class __NsModulePascal__FeatureModule {}
