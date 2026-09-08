/* Generated for __NAMESPACE__/__MODULE__ — spec: __SPEC_VERSION__ sha: __SPEC_SHA__ */
import { CommonModule } from '@angular/common';
import { HttpClientModule } from '@angular/common/http';
import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
__UI_ENTITY_IMPORTS__
import { CognitoGuard } from './guards/cognito.guard';
import { __MODULE__PolicyGuard } from './policy.guard';

const routes: Routes = [
  {
    path: '',
    canActivate: [CognitoGuard],
    children: [
__UI_ENTITY_ROUTES__
    ],
  },
];

@NgModule({
  declarations: [__UI_COMPONENTS__],
  imports: [CommonModule, HttpClientModule, RouterModule.forChild(routes)],
  providers: [__UI_SERVICES__, CognitoGuard, __MODULE__PolicyGuard],
})
export class __NsModulePascal__FeatureModule {}
