<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:w="urn:workers" xmlns:t="urn:target">
  <xsl:include href="missing-common.xsl"/>
  <xsl:template match="/">
    <t:person>
      <t:email><xsl:value-of select="/w:workers/w:worker/w:personNumber"/></t:email>
    </t:person>
  </xsl:template>
</xsl:stylesheet>
