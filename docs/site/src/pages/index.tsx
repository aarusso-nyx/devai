import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';

export default function Home(): React.JSX.Element {
  return (
    <Layout title="DEVAI" description="DEVAI documentation">
      <main className="container margin-vert--xl">
        <h1>DEVAI</h1>
        <p>Human-supervised control for AI-assisted development.</p>
        <p>
          <code>@aarusso-nyx/devai@1.1.0-rc.2</code>. One CLI package. 43 actions. 59 sensors. 7
          bounded recipes.
        </p>
        <Link className="button button--primary" to="/docs/">
          Read the documentation
        </Link>
      </main>
    </Layout>
  );
}
